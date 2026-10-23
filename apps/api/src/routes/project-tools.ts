import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { D, dec, fmt, money, sum } from "../lib/money.js";
import { isSubcontractor, projectRoleAllows, requireProject } from "../lib/permissions.js";
import { assertProjectMember, loadInProject, toSet, editable } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const date = z.iso.date();
const qty = z.union([z.number(), z.string()]).transform(String).pipe(z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "Quantity must be a non-negative number with up to 2 decimals"));
const hours = z.union([z.number(), z.string()]).transform(Number).pipe(z.number().min(0).max(24));

/** Per-project (and for correspondence, per-kind) sequence numbers; the project row lock serialises creators. */
async function next(q: Queryable, table: "correspondence" | "tm_tickets", projectId: string, kind?: string): Promise<number> {
  await q.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
  const [r] = kind
    ? await q.query<{ n: number }>(`SELECT coalesce(max(number), 0)::int + 1 AS n FROM ${table} WHERE project_id = $1 AND kind = $2`, [projectId, kind])
    : await q.query<{ n: number }>(`SELECT coalesce(max(number), 0)::int + 1 AS n FROM ${table} WHERE project_id = $1`, [projectId]);
  return r!.n;
}

async function assertCostCode(q: Queryable, projectId: string, id: string | null | undefined) {
  if (id && !(await q.query("SELECT 1 FROM cost_codes WHERE id = $1 AND project_id = $2", [id, projectId])).length) throw new HttpError(400, "Cost code not found in this project");
}

const KIND_PREFIX = { transmittal: "TR", notice: "NOT", instruction: "INS", letter: "LTR", memo: "MEM" } as const;

export const projectToolRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  // ---------- Correspondence ----------
  const corrInput = z.object({
    kind: z.enum(["transmittal", "notice", "instruction", "letter", "memo"]),
    subject: z.string().trim().min(1).max(300),
    body: optText(20000),
    dueDate: date.nullable().optional(),
    recipientIds: z.array(z.uuid()).max(100).default([]),
    private: z.boolean().default(false),
    draft: z.boolean().default(false),
  });

  app.get<P & { Querystring: { kind?: string } }>("/projects/:projectId/correspondence", async (req) => {
    const user = requireUser(req);
    const access = await requireProject(db, user.id, req.params.projectId, "read");
    const kind = z.enum(["transmittal", "notice", "instruction", "letter", "memo"]).optional().parse(req.query.kind || undefined);
    const full = projectRoleAllows(access.role, "read.full");
    // Subcontractors see only items addressed to them; private items are visible to their author, recipients and managers.
    const manager = projectRoleAllows(access.role, "record.manage");
    return db.query(
      `SELECT c.id, c.kind, c.number, c.subject, c.status, c.due_date, c.private, c.created_at, u.name AS created_by_name,
              (SELECT count(*)::int FROM correspondence_recipients r WHERE r.correspondence_id = c.id) AS recipients,
              (SELECT count(*)::int FROM correspondence_recipients r WHERE r.correspondence_id = c.id AND r.acknowledged_at IS NOT NULL) AS acknowledged
         FROM correspondence c LEFT JOIN users u ON u.id = c.created_by
        WHERE c.project_id = $1 AND ($2::text IS NULL OR c.kind = $2)
          AND (c.status <> 'draft' OR c.created_by = $3)
          AND (($4 AND (NOT c.private OR $5 OR c.created_by = $3)) OR EXISTS (SELECT 1 FROM correspondence_recipients r WHERE r.correspondence_id = c.id AND r.user_id = $3))
        ORDER BY c.created_at DESC`,
      [req.params.projectId, kind ?? null, user.id, full, manager],
    );
  });

  app.post<P>("/projects/:projectId/correspondence", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = corrInput.parse(req.body);
    const row = await db.tx(async (q) => {
      for (const r of b.recipientIds) await assertProjectMember(q, project.id, r, "Recipient");
      const number = await next(q, "correspondence", project.id, b.kind);
      const [c] = await q.query<{ id: string; number: number }>(
        `INSERT INTO correspondence (project_id, kind, number, subject, body, status, due_date, private, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, number`,
        [project.id, b.kind, number, b.subject, b.body ?? null, b.draft ? "draft" : "open", b.dueDate ?? null, b.private, user.id],
      );
      for (const r of new Set(b.recipientIds)) await q.query("INSERT INTO correspondence_recipients (correspondence_id, user_id) VALUES ($1, $2)", [c!.id, r]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "correspondence.create", entityType: "correspondence", entityId: c!.id, detail: { kind: b.kind, number } });
      if (!b.draft) {
        await config.notify(q, b.recipientIds, { kind: "correspondence", title: `${KIND_PREFIX[b.kind]}-${String(number).padStart(3, "0")}: ${b.subject}`, link: `/correspondence/${c!.id}`, projectId: project.id, actorId: user.id });
      }
      return c!;
    });
    return reply.code(201).send(row);
  });

  async function loadCorrespondence(id: string, userId: string) {
    const { row, access } = await loadInProject<{ id: string; project_id: string; created_by: string | null; private: boolean; status: string; kind: keyof typeof KIND_PREFIX; number: number; subject: string }>(db, "correspondence", id, userId, "read", "Correspondence");
    const recipients = await db.query<{ user_id: string; name: string; acknowledged_at: string | null }>(
      "SELECT r.user_id, u.name, r.acknowledged_at FROM correspondence_recipients r JOIN users u ON u.id = r.user_id WHERE r.correspondence_id = $1 ORDER BY u.name", [row.id]);
    const isRecipient = recipients.some((r) => r.user_id === userId);
    const mine = row.created_by === userId;
    const hidden = (row.status === "draft" && !mine)
      || (!isRecipient && !mine && (isSubcontractor(access) || !projectRoleAllows(access.role, "read.full") || (row.private && !projectRoleAllows(access.role, "record.manage"))));
    if (hidden) throw new HttpError(404, "Correspondence not found");
    return { row, access, recipients, isRecipient, mine };
  }

  app.get<Id>("/correspondence/:id", async (req) => {
    const user = requireUser(req);
    const { row, access, recipients, isRecipient, mine } = await loadCorrespondence(req.params.id, user.id);
    const [detail] = await db.query(`SELECT c.*, u.name AS created_by_name FROM correspondence c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = $1`, [row.id]);
    const files = await db.query(
      `SELECT f.id, f.name, f.mime, f.size FROM attachments a JOIN files f ON f.id = a.file_id WHERE a.entity_type = 'correspondence' AND a.entity_id = $1 ORDER BY a.created_at`, [row.id]);
    const canEdit = mine || projectRoleAllows(access.role, "record.manage");
    return { ...detail, recipients, files, myRole: access.role, myId: user.id, isRecipient, canEdit };
  });

  app.post<Id>("/correspondence/:id/send", async (req) => {
    const user = requireUser(req);
    const { row, access, recipients, mine } = await loadCorrespondence(req.params.id, user.id);
    if (!mine) throw new HttpError(403, "Only the author can send a draft");
    if (row.status !== "draft") throw new HttpError(409, "Already sent");
    await db.tx(async (q) => {
      await q.query("UPDATE correspondence SET status = 'open' WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "correspondence.send", entityType: "correspondence", entityId: row.id });
      await config.notify(q, recipients.map((r) => r.user_id), { kind: "correspondence", title: `${KIND_PREFIX[row.kind]}-${String(row.number).padStart(3, "0")}: ${row.subject}`, link: `/correspondence/${row.id}`, projectId: row.project_id, actorId: user.id });
    });
    return { ok: true };
  });

  app.post<Id>("/correspondence/:id/acknowledge", async (req) => {
    const user = requireUser(req);
    const { row, isRecipient } = await loadCorrespondence(req.params.id, user.id);
    if (!isRecipient) throw new HttpError(403, "Only a recipient can acknowledge");
    if (row.status === "draft") throw new HttpError(409, "Not sent yet");
    await db.query("UPDATE correspondence_recipients SET acknowledged_at = coalesce(acknowledged_at, now()) WHERE correspondence_id = $1 AND user_id = $2", [row.id, user.id]);
    return { ok: true };
  });

  app.post<Id>("/correspondence/:id/status", async (req) => {
    const user = requireUser(req);
    const { row, access, mine } = await loadCorrespondence(req.params.id, user.id);
    if (!mine && !projectRoleAllows(access.role, "record.manage")) throw new HttpError(403, "You do not have permission to do that");
    const b = z.object({ status: z.enum(["open", "closed"]) }).parse(req.body);
    if (row.status === "draft") throw new HttpError(409, "Send the draft first");
    await db.tx(async (q) => {
      await q.query("UPDATE correspondence SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() END WHERE id = $1", [row.id, b.status]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: `correspondence.${b.status === "closed" ? "close" : "reopen"}`, entityType: "correspondence", entityId: row.id });
    });
    return { ok: true };
  });

  // ---------- Direct costs ----------
  const dcInput = z.object({
    kind: z.enum(["invoice", "expense", "payroll", "subcontractor_invoice"]),
    costDate: date,
    vendor: optText(200),
    reference: optText(100),
    description: z.string().trim().min(1).max(1000),
    costCodeId: z.uuid(),
    amount: money,
  });

  app.get<P>("/projects/:projectId/direct-costs", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    const rows = await db.query<{ amount: string; status: string }>(
      `SELECT d.id, d.kind, d.cost_date, d.vendor, d.reference, d.description, d.amount::text, d.status, d.cost_code_id, cc.code AS cost_code, cc.description AS cost_code_description, u.name AS created_by_name
         FROM direct_costs d JOIN cost_codes cc ON cc.id = d.cost_code_id LEFT JOIN users u ON u.id = d.created_by
        WHERE d.project_id = $1 ORDER BY d.cost_date DESC, d.created_at DESC`,
      [req.params.projectId],
    );
    return { rows, approvedTotal: fmt(sum(rows.filter((r) => r.status === "approved").map((r) => r.amount))), pendingTotal: fmt(sum(rows.filter((r) => r.status === "pending").map((r) => r.amount))) };
  });

  app.post<P>("/projects/:projectId/direct-costs", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = dcInput.parse(req.body);
    const row = await db.tx(async (q) => {
      await assertCostCode(q, project.id, b.costCodeId);
      const [r] = await q.query<{ id: string }>(
        `INSERT INTO direct_costs (project_id, kind, cost_date, vendor, reference, description, cost_code_id, amount, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [project.id, b.kind, b.costDate, b.vendor ?? null, b.reference ?? null, b.description, b.costCodeId, b.amount, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "direct_cost.create", entityType: "direct_cost", entityId: r!.id, detail: { amount: b.amount, kind: b.kind } });
      return r!;
    });
    return reply.code(201).send(row);
  });

  app.post<Id>("/direct-costs/:id/status", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string; created_by: string | null; amount: string }>(db, "direct_costs", req.params.id, user.id, "record.manage", "Direct cost");
    const b = z.object({ status: z.enum(["approved", "rejected", "pending"]) }).parse(req.body);
    if (b.status === "approved" && row.created_by === user.id && access.role !== "admin") throw new HttpError(403, "Someone else must approve a cost you entered");
    await db.tx(async (q) => {
      await q.query("UPDATE direct_costs SET status = $2 WHERE id = $1", [row.id, b.status]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: `direct_cost.${b.status}`, entityType: "direct_cost", entityId: row.id, detail: { amount: row.amount } });
    });
    return { ok: true };
  });

  app.delete<Id>("/direct-costs/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string }>(db, "direct_costs", req.params.id, user.id, "record.manage", "Direct cost");
    if (row.status === "approved") throw new HttpError(409, "An approved cost cannot be deleted; reject it instead");
    await db.tx(async (q) => {
      await q.query("DELETE FROM direct_costs WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "direct_cost.delete", entityType: "direct_cost", entityId: row.id });
    });
    return { ok: true };
  });

  // ---------- T&M tickets ----------
  const tmLine = z.object({
    category: z.enum(["labor", "material", "equipment"]),
    description: z.string().trim().min(1).max(500),
    quantity: qty,
    unit: optText(30),
    rate: money.refine((v) => !new D(v).isNeg(), "Rate cannot be negative"),
    costCodeId: z.uuid().nullable().optional(),
  });
  const tmFields = z.object({
    workDate: date,
    description: z.string().trim().min(1).max(2000),
    company: optText(200),
    lines: z.array(tmLine).max(200),
  });
  const tmInput = tmFields.extend({ lines: tmFields.shape.lines.default([]) });

  const lineTotal = (l: { quantity: string; rate: string }) => dec(l.quantity).times(dec(l.rate));

  app.get<P>("/projects/:projectId/tm-tickets", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    const rows = await db.query<{ id: string }>(
      `SELECT t.id, t.number, t.work_date, t.description, t.company, t.status, t.signed_by, t.change_event_id,
              coalesce((SELECT json_agg(json_build_object('quantity', l.quantity::text, 'rate', l.rate::text)) FROM tm_ticket_lines l WHERE l.ticket_id = t.id), '[]') AS lines
         FROM tm_tickets t WHERE t.project_id = $1 ORDER BY t.number DESC`,
      [req.params.projectId],
    );
    // Totals use the same per-line half-even rounding as the ticket itself (SQL round() is half-away-from-zero).
    return rows.map(({ lines, ...t }: { id: string; lines?: { quantity: string; rate: string }[] }) => ({ ...t, total: fmt(sum((lines ?? []).map((l) => fmt(lineTotal(l))))) }));
  });

  async function writeTmLines(q: Queryable, projectId: string, ticketId: string, lines: z.infer<typeof tmLine>[]) {
    for (const l of lines) await assertCostCode(q, projectId, l.costCodeId);
    await q.query("DELETE FROM tm_ticket_lines WHERE ticket_id = $1", [ticketId]);
    let seq = 1;
    for (const l of lines) {
      await q.query("INSERT INTO tm_ticket_lines (ticket_id, seq, category, description, quantity, unit, rate, cost_code_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [ticketId, seq++, l.category, l.description, l.quantity, l.unit ?? null, l.rate, l.costCodeId ?? null]);
    }
  }

  app.post<P>("/projects/:projectId/tm-tickets", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = tmInput.parse(req.body);
    const row = await db.tx(async (q) => {
      const number = await next(q, "tm_tickets", project.id);
      const [t] = await q.query<{ id: string; number: number }>(
        "INSERT INTO tm_tickets (project_id, number, work_date, description, company, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, number",
        [project.id, number, b.workDate, b.description, b.company ?? null, user.id],
      );
      await writeTmLines(q, project.id, t!.id, b.lines);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "tm_ticket.create", entityType: "tm_ticket", entityId: t!.id, detail: { number } });
      return t!;
    });
    return reply.code(201).send(row);
  });

  async function tmDetail(id: string) {
    const [t] = await db.query<Record<string, unknown>>(`SELECT t.*, u.name AS created_by_name, ce.number AS change_event_number FROM tm_tickets t LEFT JOIN users u ON u.id = t.created_by LEFT JOIN change_events ce ON ce.id = t.change_event_id WHERE t.id = $1`, [id]);
    const lines = await db.query<{ quantity: string; rate: string; category: string; cost_code_id: string | null }>(
      `SELECT l.id, l.seq, l.category, l.description, l.quantity::text, l.unit, l.rate::text, l.cost_code_id, cc.code AS cost_code
         FROM tm_ticket_lines l LEFT JOIN cost_codes cc ON cc.id = l.cost_code_id WHERE l.ticket_id = $1 ORDER BY l.seq`, [id]);
    const withTotals = lines.map((l) => ({ ...l, amount: fmt(lineTotal(l)) }));
    const byCategory = Object.fromEntries((["labor", "material", "equipment"] as const).map((c) => [c, fmt(sum(withTotals.filter((l) => l.category === c).map((l) => l.amount)))]));
    return { ...t, lines: withTotals, subtotals: byCategory, total: fmt(sum(withTotals.map((l) => l.amount))) };
  }

  app.get<Id>("/tm-tickets/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "tm_tickets", req.params.id, user.id, "read.full", "T&M ticket");
    const files = await db.query(
      `SELECT f.id, f.name, f.mime, f.size FROM attachments a JOIN files f ON f.id = a.file_id WHERE a.entity_type = 'tm_ticket' AND a.entity_id = $1 ORDER BY a.created_at`, [row.id]);
    return { ...(await tmDetail(row.id)), files, myRole: access.role };
  });

  app.patch<Id>("/tm-tickets/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string }>(db, "tm_tickets", req.params.id, user.id, "record.write", "T&M ticket");
    if (row.status !== "draft" && row.status !== "rejected") throw new HttpError(409, "Only a draft or rejected ticket can be edited");
    const b = editable(tmFields).parse(req.body);
    await db.tx(async (q) => {
      const { sets, values } = toSet(b, { workDate: "work_date", description: "description", company: "company" });
      if (sets.length) await q.query(`UPDATE tm_tickets SET ${sets.join(", ")} WHERE id = $1`, [row.id, ...values]);
      if (b.lines) await writeTmLines(q, row.project_id, row.id, b.lines);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "tm_ticket.update", entityType: "tm_ticket", entityId: row.id });
    });
    return tmDetail(row.id);
  });

  /** draft → submitted (with the customer's signature name) → approved/rejected by a manager. */
  app.post<Id>("/tm-tickets/:id/status", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string }>(db, "tm_tickets", req.params.id, user.id, "record.write", "T&M ticket");
    const b = z.object({ status: z.enum(["submitted", "approved", "rejected"]), signedBy: z.string().trim().min(1).max(200).optional() }).parse(req.body);
    const allowed: Record<string, string[]> = { draft: ["submitted"], rejected: ["submitted"], submitted: ["approved", "rejected"], approved: [] };
    if (!allowed[row.status]!.includes(b.status)) throw new HttpError(409, `A ${row.status} ticket cannot be marked ${b.status}`);
    if (b.status !== "submitted" && !projectRoleAllows(access.role, "record.manage")) throw new HttpError(403, "Only a project manager can approve or reject");
    if (b.status === "submitted") {
      if (!b.signedBy) throw new HttpError(400, "Enter the name of the person who signed the ticket in the field");
      const [n] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM tm_ticket_lines WHERE ticket_id = $1", [row.id]);
      if (!n!.n) throw new HttpError(400, "Add at least one labor, material or equipment line");
    }
    await db.tx(async (q) => {
      await q.query(
        `UPDATE tm_tickets SET status = $2, signed_by = CASE WHEN $2 = 'submitted' THEN $3 ELSE signed_by END, signed_at = CASE WHEN $2 = 'submitted' THEN now() ELSE signed_at END WHERE id = $1`,
        [row.id, b.status, b.signedBy ?? null],
      );
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: `tm_ticket.${b.status}`, entityType: "tm_ticket", entityId: row.id, detail: b.signedBy ? { signedBy: b.signedBy } : {} });
    });
    return tmDetail(row.id);
  });

  /** Turns an approved ticket into a change event: one line per cost code, cost = revenue = ticket amount (markup is applied on the CO). */
  app.post<Id>("/tm-tickets/:id/change-event", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string; number: number; description: string; change_event_id: string | null }>(db, "tm_tickets", req.params.id, user.id, "record.manage", "T&M ticket");
    if (row.status !== "approved") throw new HttpError(409, "Approve the ticket first");
    if (row.change_event_id) throw new HttpError(409, "This ticket already has a change event");
    const detail = await tmDetail(row.id);
    const missing = detail.lines.filter((l) => !l.cost_code_id);
    if (missing.length) throw new HttpError(400, "Every line needs a cost code before it can become a change event");
    const byCode = new Map<string, InstanceType<typeof D>>();
    for (const l of detail.lines) byCode.set(l.cost_code_id as string, (byCode.get(l.cost_code_id as string) ?? new D(0)).plus(l.amount));
    const ce = await db.tx(async (q) => {
      await q.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [row.project_id]);
      const [n] = await q.query<{ n: number }>("SELECT coalesce(max(number), 0)::int + 1 AS n FROM change_events WHERE project_id = $1", [row.project_id]);
      const [c] = await q.query<{ id: string; number: number }>(
        `INSERT INTO change_events (project_id, number, title, description, reason, scope, created_by) VALUES ($1, $2, $3, $4, 'other', 'tbd', $5) RETURNING id, number`,
        [row.project_id, n!.n, `T&M ticket #${row.number}`, row.description, user.id],
      );
      for (const [code, amt] of byCode) {
        await q.query("INSERT INTO change_event_lines (change_event_id, cost_code_id, description, estimated_cost, estimated_revenue) VALUES ($1, $2, $3, $4, $4)", [c!.id, code, `T&M ticket #${row.number}`, fmt(amt)]);
      }
      await q.query("UPDATE tm_tickets SET change_event_id = $2 WHERE id = $1", [row.id, c!.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "change_event.create", entityType: "change_event", entityId: c!.id, detail: { fromTmTicket: row.number } });
      return c!;
    });
    return reply.code(201).send(ce);
  });

  // ---------- Equipment ----------
  const eqFields = z.object({
    name: z.string().trim().min(1).max(200),
    category: optText(100),
    ownership: z.enum(["owned", "rented", "subcontractor"]),
    identifier: optText(100),
    hourlyRate: money.refine((v) => !new D(v).isNeg(), "Rate cannot be negative"),
    status: z.enum(["on_site", "off_site", "down"]),
  });
  const eqInput = eqFields.extend({ ownership: eqFields.shape.ownership.default("owned"), hourlyRate: eqFields.shape.hourlyRate.default("0"), status: eqFields.shape.status.default("on_site") });

  app.get<P>("/projects/:projectId/equipment", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT e.id, e.name, e.category, e.ownership, e.identifier, e.hourly_rate::text, e.status,
              coalesce((SELECT sum(l.hours_operated) FROM equipment_logs l WHERE l.equipment_id = e.id), 0)::text AS hours_operated,
              coalesce((SELECT sum(l.hours_idle) FROM equipment_logs l WHERE l.equipment_id = e.id), 0)::text AS hours_idle,
              (SELECT max(l.log_date) FROM equipment_logs l WHERE l.equipment_id = e.id) AS last_used
         FROM equipment e WHERE e.project_id = $1 ORDER BY e.name`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/equipment", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = eqInput.parse(req.body);
    const row = await db.tx(async (q) => {
      if ((await q.query("SELECT 1 FROM equipment WHERE project_id = $1 AND lower(name) = lower($2)", [project.id, b.name])).length) throw new HttpError(409, "Equipment with that name already exists");
      const [e] = await q.query<{ id: string }>(
        "INSERT INTO equipment (project_id, name, category, ownership, identifier, hourly_rate, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [project.id, b.name, b.category ?? null, b.ownership, b.identifier ?? null, b.hourlyRate, b.status],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "equipment.create", entityType: "equipment", entityId: e!.id, detail: { name: b.name } });
      return e!;
    });
    return reply.code(201).send(row);
  });

  app.get<Id>("/equipment/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; hourly_rate: string }>(db, "equipment", req.params.id, user.id, "read.full", "Equipment");
    const logs = await db.query<{ hours_operated: string }>(
      `SELECT l.id, l.log_date, l.hours_operated::text, l.hours_idle::text, l.notes, cc.code AS cost_code, u.name AS created_by_name
         FROM equipment_logs l LEFT JOIN cost_codes cc ON cc.id = l.cost_code_id LEFT JOIN users u ON u.id = l.created_by
        WHERE l.equipment_id = $1 ORDER BY l.log_date DESC, l.created_at DESC`, [row.id]);
    const operated = sum(logs.map((l) => l.hours_operated));
    return { ...row, hourly_rate: fmt(dec(row.hourly_rate)), logs, hoursOperated: operated.toFixed(2), operatingCost: fmt(operated.times(dec(row.hourly_rate))), myRole: access.role };
  });

  app.patch<Id>("/equipment/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "equipment", req.params.id, user.id, "record.write", "Equipment");
    const b = editable(eqFields).parse(req.body);
    const { sets, values } = toSet(b, { name: "name", category: "category", ownership: "ownership", identifier: "identifier", hourlyRate: "hourly_rate", status: "status" });
    if (!sets.length) return { ok: true };
    await db.tx(async (q) => {
      await q.query(`UPDATE equipment SET ${sets.join(", ")} WHERE id = $1`, [row.id, ...values]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "equipment.update", entityType: "equipment", entityId: row.id, detail: b });
    });
    return { ok: true };
  });

  app.post<Id>("/equipment/:id/logs", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "equipment", req.params.id, user.id, "record.write", "Equipment");
    const b = z.object({ logDate: date, hoursOperated: hours.default(0), hoursIdle: hours.default(0), costCodeId: z.uuid().nullable().optional(), notes: optText(1000) }).parse(req.body);
    const out = await db.tx(async (q) => {
      await assertCostCode(q, row.project_id, b.costCodeId);
      const [day] = await q.query<{ h: string }>("SELECT coalesce(sum(hours_operated + hours_idle), 0)::text AS h FROM equipment_logs WHERE equipment_id = $1 AND log_date = $2", [row.id, b.logDate]);
      if (dec(day!.h).plus(b.hoursOperated).plus(b.hoursIdle).gt(24)) throw new HttpError(400, "More than 24 hours logged for this equipment on that day");
      const [l] = await q.query<{ id: string }>(
        "INSERT INTO equipment_logs (equipment_id, log_date, hours_operated, hours_idle, cost_code_id, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [row.id, b.logDate, b.hoursOperated, b.hoursIdle, b.costCodeId ?? null, b.notes ?? null, user.id],
      );
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "equipment.log", entityType: "equipment", entityId: row.id, detail: { date: b.logDate, hours: b.hoursOperated } });
      return l!;
    });
    return reply.code(201).send(out);
  });

};
