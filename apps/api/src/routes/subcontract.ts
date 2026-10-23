import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { computePayApp, scheduleOfValues } from "../lib/finance.js";
import { fmt, nonNegativeMoney, sum } from "../lib/money.js";
import { projectRoleAllows, requireProject } from "../lib/permissions.js";
import { assertProjectMember, editable, loadInProject, toSet } from "../lib/records.js";
import { isContact, paymentBlockers } from "./financials.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

/** Commitment-side workflows shared with subcontractors: invoice contacts, insurance compliance and lien waivers. */
export const subcontractRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  /** The commitment, with access for the project team (`need`) or, read-only plus uploads, its invoice contacts. */
  async function contract(id: string, userId: string, need: "read.full" | "record.write" | "record.manage") {
    const { row, access } = await loadInProject<{ id: string; project_id: string; kind: string; number: number; title: string; require_insurance: boolean; require_lien_waivers: boolean }>(db, "contracts", id, userId, "read", "Contract");
    const contact = await isContact(db, row.id, userId);
    if (!projectRoleAllows(access.role, need) && !(contact && need !== "record.manage")) {
      if (!contact && !projectRoleAllows(access.role, "read.full")) throw new HttpError(404, "Contract not found");
      throw new HttpError(403, "You do not have permission to do that");
    }
    return { row, access, contact };
  }

  // ---------- Invoice contacts ----------

  app.put<Id>("/contracts/:id/contacts", async (req) => {
    const user = requireUser(req);
    const { row, access } = await contract(req.params.id, user.id, "record.manage");
    if (row.kind === "prime") throw new HttpError(400, "Invoice contacts are for subcontracts and purchase orders");
    const b = z.object({ userIds: z.array(z.uuid()).max(20) }).parse(req.body);
    await db.tx(async (q) => {
      for (const u of b.userIds) await assertProjectMember(q, row.project_id, u, "Contact");
      await q.query("DELETE FROM contract_contacts WHERE contract_id = $1", [row.id]);
      for (const u of new Set(b.userIds)) await q.query("INSERT INTO contract_contacts (contract_id, user_id) VALUES ($1, $2)", [row.id, u]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "contract.contacts", entityType: "contract", entityId: row.id, detail: { contacts: b.userIds.length } });
      const added = b.userIds;
      await config.notify(q, added, { kind: "contract", title: `You can now submit invoices for ${row.title}`, link: `/projects/${row.project_id}/my-contracts`, projectId: row.project_id, actorId: user.id });
    });
    return { ok: true };
  });

  app.patch<Id>("/contracts/:id/requirements", async (req) => {
    const user = requireUser(req);
    const { row, access } = await contract(req.params.id, user.id, "record.manage");
    const b = z.object({ requireInsurance: z.boolean().optional(), requireLienWaivers: z.boolean().optional() }).parse(req.body);
    await db.tx(async (q) => {
      await q.query("UPDATE contracts SET require_insurance = coalesce($2, require_insurance), require_lien_waivers = coalesce($3, require_lien_waivers) WHERE id = $1", [row.id, b.requireInsurance ?? null, b.requireLienWaivers ?? null]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "contract.requirements", entityType: "contract", entityId: row.id, detail: b });
    });
    return { ok: true };
  });

  /** A subcontractor's commitments on this project: schedule of values, invoices and compliance status. */
  app.get<P>("/projects/:projectId/my-contracts", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    const ks = await db.query<{ id: string }>(
      `SELECT k.id, k.number, k.kind, k.title, k.counterparty, k.status, k.retainage_percent::text, k.require_insurance, k.require_lien_waivers
         FROM contracts k JOIN contract_contacts c ON c.contract_id = k.id AND c.user_id = $2 WHERE k.project_id = $1 ORDER BY k.number`,
      [req.params.projectId, user.id],
    );
    const out = [];
    for (const k of ks) {
      const sov = await scheduleOfValues(db, k.id);
      const invoices = await db.query<{ id: string }>("SELECT id, number, period_start, period_end, status FROM invoices WHERE contract_id = $1 ORDER BY created_at DESC", [k.id]);
      const withTotals = [];
      for (const i of invoices) {
        const pa = await computePayApp(db, i.id);
        withTotals.push({ ...i, completed_to_date: pa.totals.completed_to_date, current_payment_due: pa.totals.current_payment_due, paymentBlockers: await paymentBlockers(db, i.id) });
      }
      const compliance = await db.query("SELECT id, kind, carrier, policy_number, expires_on, status FROM compliance_documents WHERE contract_id = $1 ORDER BY kind, expires_on DESC NULLS LAST", [k.id]);
      out.push({ ...k, sov, contractSum: fmt(sum(sov.map((s) => s.scheduled_value))), invoices: withTotals, compliance });
    }
    return out;
  });

  // ---------- Insurance / compliance documents ----------

  const docFields = z.object({
    kind: z.enum(["general_liability", "workers_comp", "auto", "umbrella", "w9", "license", "other"]),
    carrier: optText(200),
    policyNumber: optText(100),
    limitAmount: nonNegativeMoney.nullable().optional(),
    effectiveOn: z.iso.date().nullable().optional(),
    expiresOn: z.iso.date().nullable().optional(),
    note: optText(2000),
  });

  app.get<Id>("/contracts/:id/compliance", async (req) => {
    const user = requireUser(req);
    const { row } = await contract(req.params.id, user.id, "read.full");
    const docs = await db.query(
      `SELECT d.id, d.kind, d.carrier, d.policy_number, d.limit_amount::text, d.effective_on, d.expires_on, d.status, d.note, d.created_at, u.name AS created_by_name,
              (d.expires_on IS NOT NULL AND d.expires_on < current_date) AS expired,
              (d.expires_on IS NOT NULL AND d.expires_on >= current_date AND d.expires_on < current_date + 30) AS expiring,
              (SELECT coalesce(json_agg(json_build_object('id', f.id, 'name', f.name)), '[]') FROM attachments a JOIN files f ON f.id = a.file_id WHERE a.entity_type = 'compliance_document' AND a.entity_id = d.id) AS files
         FROM compliance_documents d LEFT JOIN users u ON u.id = d.created_by WHERE d.contract_id = $1 ORDER BY d.kind, d.expires_on DESC NULLS LAST`,
      [row.id],
    );
    return { requireInsurance: row.require_insurance, requireLienWaivers: row.require_lien_waivers, documents: docs };
  });

  /** Subcontractor contacts upload their own certificates; the project team accepts or rejects them. */
  app.post<Id>("/contracts/:id/compliance", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await contract(req.params.id, user.id, "record.write");
    const b = docFields.parse(req.body);
    if (b.effectiveOn && b.expiresOn && b.expiresOn < b.effectiveOn) throw new HttpError(400, "The policy expires before it starts");
    const doc = await db.tx(async (q) => {
      const [d] = await q.query<{ id: string }>(
        `INSERT INTO compliance_documents (project_id, contract_id, kind, carrier, policy_number, limit_amount, effective_on, expires_on, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [row.project_id, row.id, b.kind, b.carrier ?? null, b.policyNumber ?? null, b.limitAmount ?? null, b.effectiveOn ?? null, b.expiresOn ?? null, b.note ?? null, user.id],
      );
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "compliance.add", entityType: "contract", entityId: row.id, detail: { kind: b.kind, expires: b.expiresOn ?? null } });
      return d!;
    });
    return reply.code(201).send(doc);
  });

  app.patch<Id>("/compliance-documents/:id", async (req) => {
    const user = requireUser(req);
    const { row: d } = await loadInProject<{ id: string; contract_id: string; project_id: string }>(db, "compliance_documents", req.params.id, user.id, "read", "Document");
    const { access, contact } = await contract(d.contract_id, user.id, "record.write");
    const b = editable(docFields).extend({ status: z.enum(["pending", "accepted", "rejected"]).optional() }).parse(req.body);
    if (b.status && !projectRoleAllows(access.role, "record.manage")) throw new HttpError(403, "Only a project manager can accept or reject compliance documents");
    if (contact && !projectRoleAllows(access.role, "record.write") && Object.keys(b).some((k) => k !== "note")) {
      const [cur] = await db.query<{ status: string }>("SELECT status FROM compliance_documents WHERE id = $1", [d.id]);
      if (cur!.status === "accepted") throw new HttpError(409, "An accepted certificate cannot be changed; upload a new one");
    }
    const { sets, values } = toSet(b, { kind: "kind", carrier: "carrier", policyNumber: "policy_number", limitAmount: "limit_amount", effectiveOn: "effective_on", expiresOn: "expires_on", note: "note", status: "status" });
    if (sets.length) {
      await db.tx(async (q) => {
        await q.query(`UPDATE compliance_documents SET ${sets.join(", ")} WHERE id = $1`, [d.id, ...values]);
        await audit(q, { orgId: access.project.org_id, projectId: d.project_id, actorId: user.id, action: b.status ? `compliance.${b.status}` : "compliance.update", entityType: "contract", entityId: d.contract_id, detail: { document: d.id } });
      });
    }
    return { ok: true };
  });

  // ---------- Lien waivers ----------

  app.post<Id>("/invoices/:id/lien-waivers", async (req, reply) => {
    const user = requireUser(req);
    const { row: inv, access } = await loadInProject<{ id: string; project_id: string; contract_id: string; period_end: string }>(db, "invoices", req.params.id, user.id, "read", "Invoice");
    const contact = await isContact(db, inv.contract_id, user.id);
    if (!projectRoleAllows(access.role, "record.write") && !contact) throw new HttpError(404, "Invoice not found");
    const b = z.object({
      kind: z.enum(["conditional_progress", "unconditional_progress", "conditional_final", "unconditional_final"]),
      amount: nonNegativeMoney.optional(),
      throughDate: z.iso.date().optional(),
      status: z.enum(["requested", "received"]).default(contact && !projectRoleAllows(access.role, "record.write") ? "received" : "requested"),
    }).parse(req.body);
    const pa = await computePayApp(db, inv.id);
    const w = await db.tx(async (q) => {
      const [r] = await q.query<{ id: string }>(
        `INSERT INTO lien_waivers (project_id, invoice_id, kind, amount, through_date, status, received_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'received' THEN now() END, $7)
         ON CONFLICT (invoice_id, kind) DO UPDATE SET amount = EXCLUDED.amount, through_date = EXCLUDED.through_date,
           status = CASE WHEN lien_waivers.status = 'accepted' THEN 'accepted' ELSE EXCLUDED.status END,
           received_at = coalesce(lien_waivers.received_at, EXCLUDED.received_at)
         RETURNING id`,
        [inv.project_id, inv.id, b.kind, b.amount ?? pa.totals.current_payment_due, b.throughDate ?? inv.period_end, b.status, user.id],
      );
      await audit(q, { orgId: access.project.org_id, projectId: inv.project_id, actorId: user.id, action: `lien_waiver.${b.status}`, entityType: "invoice", entityId: inv.id, detail: { kind: b.kind } });
      return r!;
    });
    return reply.code(201).send(w);
  });

  app.post<Id>("/lien-waivers/:id/status", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; invoice_id: string; status: string }>(db, "lien_waivers", req.params.id, user.id, "record.manage", "Lien waiver");
    const b = z.object({ status: z.enum(["accepted", "rejected"]) }).parse(req.body);
    if (row.status === "requested") throw new HttpError(409, "The waiver has not been received yet");
    await db.tx(async (q) => {
      await q.query("UPDATE lien_waivers SET status = $2 WHERE id = $1", [row.id, b.status]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: `lien_waiver.${b.status}`, entityType: "invoice", entityId: row.invoice_id });
    });
    return { ok: true };
  });
};
