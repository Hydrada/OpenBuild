import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { listSteps, startRound } from "../lib/approvals.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { budgetReport, computePayApp, scheduleOfValues, toCsv } from "../lib/finance.js";
import { dec, fmt, money, nonNegativeMoney, percent, sum } from "../lib/money.js";
import { isUuid, requireProject } from "../lib/permissions.js";
import { assertProjectMember, loadInProject, nextNumber, editable } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

const line = z.object({ costCodeId: z.uuid(), description: z.string().trim().min(1).max(500), amount: money });
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

export const financialRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  async function assertCostCodes(q: Queryable, projectId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    const [r] = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM cost_codes WHERE project_id = $1 AND id = ANY($2::uuid[])", [projectId, unique]);
    if (r!.n !== unique.length) throw new HttpError(400, "Unknown cost code for this project");
  }

  // ---------- Cost codes ----------

  app.get<P>("/projects/:projectId/cost-codes", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query("SELECT id, code, description FROM cost_codes WHERE project_id = $1 ORDER BY code", [req.params.projectId]);
  });

  /** Create one ({code, description}) or import many ({csv: "code,description\n..."}). Existing codes are skipped. */
  app.post<P>("/projects/:projectId/cost-codes", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const b = z.union([
      z.object({ code: z.string().trim().min(1).max(40), description: z.string().trim().min(1).max(200) }),
      z.object({ csv: z.string().max(500_000) }),
    ]).parse(req.body);
    const entries = "csv" in b ? parseCostCodeCsv(b.csv) : [b];
    if (!entries.length) throw new HttpError(400, "No cost codes found");
    const created = await db.tx(async (q) => {
      let n = 0;
      for (const e of entries) {
        const r = await q.query("INSERT INTO cost_codes (project_id, code, description) VALUES ($1, $2, $3) ON CONFLICT (project_id, code) DO NOTHING RETURNING id", [project.id, e.code, e.description]);
        n += r.length;
      }
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "cost_code.import", entityType: "project", entityId: project.id, detail: { created: n, submitted: entries.length } });
      return n;
    });
    return reply.code(201).send({ created, skipped: entries.length - created });
  });

  // ---------- Budget ----------

  app.get<P>("/projects/:projectId/budget", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    const report = await budgetReport(db, req.params.projectId);
    const [locked] = await db.query<{ locked: boolean }>("SELECT bool_or(locked) AS locked FROM budget_lines WHERE project_id = $1", [req.params.projectId]);
    const modifications = await db.query(
      `SELECT m.id, f.code AS from_code, t.code AS to_code, m.amount::text, m.reason, m.created_at, u.name AS created_by_name
         FROM budget_modifications m JOIN cost_codes f ON f.id = m.from_cost_code_id JOIN cost_codes t ON t.id = m.to_cost_code_id
         LEFT JOIN users u ON u.id = m.created_by WHERE m.project_id = $1 ORDER BY m.created_at DESC`,
      [req.params.projectId],
    );
    return { ...report, locked: !!locked?.locked, modifications };
  });

  app.get<P>("/projects/:projectId/budget.csv", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "read.full");
    const { rows, totals } = await budgetReport(db, project.id);
    const headers = ["Cost code", "Description", "Original budget", "Budget modifications", "Approved changes", "Revised budget", "Pending budget changes", "Committed costs", "Pending cost changes", "Change event exposure", "Direct costs", "Forecast to complete", "Estimated cost at completion", "Projected over/under"];
    const data = rows.map((r) => [r.cost_code, r.description, r.original_budget, r.budget_modifications, r.approved_changes, r.revised_budget, r.pending_budget_changes, r.committed_costs, r.pending_cost_changes, r.change_event_exposure, r.direct_costs, r.forecast_to_complete, r.estimated_cost_at_completion, r.projected_over_under]);
    data.push(["TOTAL", "", totals.original_budget, totals.budget_modifications, totals.approved_changes, totals.revised_budget, totals.pending_budget_changes, totals.committed_costs, totals.pending_cost_changes, totals.change_event_exposure, totals.direct_costs, "", totals.estimated_cost_at_completion, totals.projected_over_under]);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="budget-${safeName(project.name)}.csv"`);
    return toCsv(headers, data);
  });

  app.put<{ Params: { projectId: string; costCodeId: string } }>("/projects/:projectId/budget/lines/:costCodeId", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const b = z.object({ originalAmount: nonNegativeMoney.optional(), forecastToComplete: nonNegativeMoney.nullable().optional(), notes: optText(2000) }).parse(req.body);
    if (!isUuid(req.params.costCodeId)) throw new HttpError(404, "Cost code not found");
    return db.tx(async (q) => {
      await assertCostCodes(q, project.id, [req.params.costCodeId]);
      const [existing] = await q.query<{ locked: boolean; original_amount: string }>("SELECT locked, original_amount::text FROM budget_lines WHERE project_id = $1 AND cost_code_id = $2", [project.id, req.params.costCodeId]);
      const [anyLocked] = await q.query<{ l: boolean }>("SELECT bool_or(locked) AS l FROM budget_lines WHERE project_id = $1", [project.id]);
      if (b.originalAmount !== undefined && anyLocked?.l && b.originalAmount !== existing?.original_amount) {
        throw new HttpError(409, "The original budget is locked; use a budget modification");
      }
      await q.query(
        `INSERT INTO budget_lines (project_id, cost_code_id, original_amount, forecast_to_complete, notes, locked)
         VALUES ($1, $2, coalesce($3::numeric, 0), $4, $5, coalesce($6, false))
         ON CONFLICT (project_id, cost_code_id) DO UPDATE SET
           original_amount = coalesce($3::numeric, budget_lines.original_amount),
           forecast_to_complete = CASE WHEN $7 THEN $4::numeric ELSE budget_lines.forecast_to_complete END,
           notes = coalesce($5, budget_lines.notes)`,
        [project.id, req.params.costCodeId, b.originalAmount ?? null, b.forecastToComplete ?? null, b.notes ?? null, anyLocked?.l ?? false, b.forecastToComplete !== undefined],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "budget.line", entityType: "cost_code", entityId: req.params.costCodeId, detail: { ...b, previous: existing?.original_amount ?? null } });
      return { ok: true };
    });
  });

  app.post<P>("/projects/:projectId/budget/lock", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    return db.tx(async (q) => {
      // Every cost code gets a line so later lines are locked too.
      await q.query(`INSERT INTO budget_lines (project_id, cost_code_id) SELECT project_id, id FROM cost_codes WHERE project_id = $1 ON CONFLICT DO NOTHING`, [project.id]);
      await q.query("UPDATE budget_lines SET locked = true WHERE project_id = $1", [project.id]);
      const [t] = await q.query<{ total: string }>("SELECT sum(original_amount)::text AS total FROM budget_lines WHERE project_id = $1", [project.id]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "budget.lock", entityType: "project", entityId: project.id, detail: { originalTotal: t!.total } });
      return { ok: true };
    });
  });

  app.post<P>("/projects/:projectId/budget/modifications", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const b = z.object({ fromCostCodeId: z.uuid(), toCostCodeId: z.uuid(), amount: nonNegativeMoney, reason: z.string().trim().min(1).max(1000) }).parse(req.body);
    if (b.fromCostCodeId === b.toCostCodeId) throw new HttpError(400, "Choose two different cost codes");
    if (dec(b.amount).isZero()) throw new HttpError(400, "Amount must be greater than zero");
    const mod = await db.tx(async (q) => {
      await assertCostCodes(q, project.id, [b.fromCostCodeId, b.toCostCodeId]);
      const [m] = await q.query<{ id: string }>(
        `INSERT INTO budget_modifications (project_id, from_cost_code_id, to_cost_code_id, amount, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [project.id, b.fromCostCodeId, b.toCostCodeId, b.amount, b.reason, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "budget.modification", entityType: "budget_modification", entityId: m!.id, detail: b });
      return m!;
    });
    return reply.code(201).send(mod);
  });

  // ---------- Contracts (prime, subcontracts, purchase orders) ----------

  app.get<P>("/projects/:projectId/contracts", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT k.id, k.number, k.kind, k.title, k.counterparty, k.status, k.retainage_percent::text,
              coalesce((SELECT sum(amount) FROM contract_lines WHERE contract_id = k.id), 0)::text AS original_amount,
              coalesce((SELECT sum(l.amount) FROM change_order_lines l JOIN change_orders co ON co.id = l.change_order_id WHERE co.contract_id = k.id AND co.status = 'approved'), 0)::text AS approved_changes,
              coalesce((SELECT sum(l.amount) FROM change_order_lines l JOIN change_orders co ON co.id = l.change_order_id WHERE co.contract_id = k.id AND co.status = 'pending'), 0)::text AS pending_changes
         FROM contracts k WHERE k.project_id = $1 ORDER BY k.kind <> 'prime', k.number`,
      [req.params.projectId],
    );
  });

  const contractInput = z.object({
    kind: z.enum(["prime", "subcontract", "purchase_order"]),
    title: z.string().trim().min(1).max(300),
    counterparty: z.string().trim().min(1).max(300),
    retainagePercent: percent.default("0.00"),
    executedDate: z.iso.date().nullable().optional(),
    lines: z.array(line).max(500).default([]),
  });

  app.post<P>("/projects/:projectId/contracts", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const b = contractInput.parse(req.body);
    const k = await db.tx(async (q) => {
      await assertCostCodes(q, project.id, b.lines.map((l) => l.costCodeId));
      if (b.kind === "prime" && (await q.query("SELECT 1 FROM contracts WHERE project_id = $1 AND kind = 'prime' AND status <> 'terminated'", [project.id])).length) {
        throw new HttpError(409, "This project already has a prime contract");
      }
      const number = await nextNumber(q, "contracts", project.id);
      const [row] = await q.query<{ id: string }>(
        `INSERT INTO contracts (project_id, number, kind, title, counterparty, retainage_percent, executed_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, number`,
        [project.id, number, b.kind, b.title, b.counterparty, b.retainagePercent, b.executedDate ?? null, user.id],
      );
      await writeLines(q, "contract_lines", "contract_id", row!.id, b.lines);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "contract.create", entityType: "contract", entityId: row!.id, detail: { number, kind: b.kind, title: b.title, total: fmt(sum(b.lines.map((l) => l.amount))) } });
      return row!;
    });
    return reply.code(201).send(k);
  });

  async function writeLines(q: Queryable, table: "contract_lines" | "change_order_lines", fk: string, id: string, lines: z.infer<typeof line>[]) {
    await q.query(`DELETE FROM ${table} WHERE ${fk} = $1`, [id]);
    for (const [i, l] of lines.entries()) {
      await q.query(`INSERT INTO ${table} (${fk}, seq, cost_code_id, description, amount) VALUES ($1, $2, $3, $4, $5)`, [id, i + 1, l.costCodeId, l.description, l.amount]);
    }
  }

  app.get<Id>("/contracts/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string }>(db, "contracts", req.params.id, user.id, "read.full", "Contract");
    const lines = await db.query(
      `SELECT l.id, l.seq, l.cost_code_id, c.code AS cost_code, l.description, l.amount::text FROM contract_lines l JOIN cost_codes c ON c.id = l.cost_code_id WHERE l.contract_id = $1 ORDER BY l.seq`,
      [row.id],
    );
    const changeOrders = await db.query(
      `SELECT co.id, co.number, co.title, co.status, coalesce(sum(l.amount), 0)::text AS amount FROM change_orders co LEFT JOIN change_order_lines l ON l.change_order_id = co.id
        WHERE co.contract_id = $1 GROUP BY co.id ORDER BY co.number`,
      [row.id],
    );
    const invoices = await db.query("SELECT id, number, period_start, period_end, status FROM invoices WHERE contract_id = $1 ORDER BY created_at", [row.id]);
    const sov = await scheduleOfValues(db, row.id);
    const original = sum(lines.map((l) => (l as { amount: string }).amount));
    const approved = sum(sov.filter((s) => s.change_order_line_id).map((s) => s.scheduled_value));
    return { ...row, retainage_percent: fmt(dec((row as unknown as { retainage_percent: string }).retainage_percent)), lines, changeOrders, invoices, sov, totals: { original: fmt(original), approved_changes: fmt(approved), revised: fmt(original.plus(approved)) }, myRole: access.role };
  });

  app.patch<Id>("/contracts/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string }>(db, "contracts", req.params.id, user.id, "record.manage", "Contract");
    if (row.status !== "draft") throw new HttpError(409, "Approved contracts change only through change orders");
    const b = editable(contractInput.omit({ kind: true })).parse(req.body);
    return db.tx(async (q) => {
      await q.query(
        `UPDATE contracts SET title = coalesce($2, title), counterparty = coalesce($3, counterparty), retainage_percent = coalesce($4::numeric, retainage_percent),
                executed_date = CASE WHEN $6 THEN $5::date ELSE executed_date END WHERE id = $1`,
        [row.id, b.title ?? null, b.counterparty ?? null, b.retainagePercent ?? null, b.executedDate ?? null, b.executedDate !== undefined],
      );
      if (b.lines) {
        await assertCostCodes(q, row.project_id, b.lines.map((l) => l.costCodeId));
        await writeLines(q, "contract_lines", "contract_id", row.id, b.lines);
      }
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "contract.update", entityType: "contract", entityId: row.id, detail: { ...b, lines: b.lines?.length } });
      return { ok: true };
    });
  });

  app.post<Id>("/contracts/:id/status", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number }>(db, "contracts", req.params.id, user.id, "record.manage", "Contract");
    const b = z.object({ status: z.enum(["approved", "complete", "terminated"]) }).parse(req.body);
    const allowed: Record<string, string[]> = { draft: ["approved", "terminated"], approved: ["complete", "terminated"], complete: [], terminated: [] };
    if (!allowed[row.status]!.includes(b.status)) throw new HttpError(409, `A ${row.status} contract cannot become ${b.status}`);
    return db.tx(async (q) => {
      if (b.status === "approved") {
        const [n] = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM contract_lines WHERE contract_id = $1", [row.id]);
        if (!n!.n) throw new HttpError(400, "Add at least one line before approving");
      }
      await q.query(`UPDATE contracts SET status = $2, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END WHERE id = $1`, [row.id, b.status]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: `contract.${b.status}`, entityType: "contract", entityId: row.id, detail: { number: row.number } });
      return { ok: true };
    });
  });

  // ---------- Change events ----------

  const ceLine = z.object({ costCodeId: z.uuid(), description: z.string().trim().min(1).max(500), estimatedCost: money.default("0.00"), estimatedRevenue: money.default("0.00") });
  const ceInput = z.object({
    title: z.string().trim().min(1).max(300),
    description: optText(10000),
    reason: z.enum(["owner_change", "design_error", "unforeseen_condition", "allowance", "other"]).default("owner_change"),
    scope: z.enum(["in_scope", "out_of_scope", "tbd"]).default("tbd"),
    rfiId: z.uuid().nullable().optional(),
    lines: z.array(ceLine).max(200).default([]),
  });

  app.get<P>("/projects/:projectId/change-events", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT ce.id, ce.number, ce.title, ce.reason, ce.scope, ce.status, ce.created_at,
              coalesce(sum(l.estimated_cost), 0)::text AS estimated_cost, coalesce(sum(l.estimated_revenue), 0)::text AS estimated_revenue,
              (SELECT count(*)::int FROM change_orders co WHERE co.change_event_id = ce.id) AS change_orders
         FROM change_events ce LEFT JOIN change_event_lines l ON l.change_event_id = ce.id
        WHERE ce.project_id = $1 GROUP BY ce.id ORDER BY ce.number DESC`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/change-events", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = ceInput.parse(req.body);
    const ce = await db.tx(async (q) => {
      await assertCostCodes(q, project.id, b.lines.map((l) => l.costCodeId));
      if (b.rfiId && !(await q.query("SELECT 1 FROM rfis WHERE id = $1 AND project_id = $2", [b.rfiId, project.id])).length) throw new HttpError(400, "RFI not found in this project");
      const number = await nextNumber(q, "change_events", project.id);
      const [row] = await q.query<{ id: string }>(
        `INSERT INTO change_events (project_id, number, title, description, reason, scope, rfi_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, number`,
        [project.id, number, b.title, b.description ?? null, b.reason, b.scope, b.rfiId ?? null, user.id],
      );
      await writeCeLines(q, row!.id, b.lines);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "change_event.create", entityType: "change_event", entityId: row!.id, detail: { number, title: b.title } });
      return row!;
    });
    return reply.code(201).send(ce);
  });

  async function writeCeLines(q: Queryable, id: string, lines: z.infer<typeof ceLine>[]) {
    await q.query("DELETE FROM change_event_lines WHERE change_event_id = $1", [id]);
    for (const l of lines) {
      await q.query("INSERT INTO change_event_lines (change_event_id, cost_code_id, description, estimated_cost, estimated_revenue) VALUES ($1, $2, $3, $4, $5)", [id, l.costCodeId, l.description, l.estimatedCost, l.estimatedRevenue]);
    }
  }

  app.get<Id>("/change-events/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string }>(db, "change_events", req.params.id, user.id, "read.full", "Change event");
    const lines = await db.query(
      `SELECT l.id, l.cost_code_id, c.code AS cost_code, l.description, l.estimated_cost::text, l.estimated_revenue::text FROM change_event_lines l JOIN cost_codes c ON c.id = l.cost_code_id WHERE l.change_event_id = $1 ORDER BY c.code`,
      [row.id],
    );
    const cos = await db.query(
      `SELECT co.id, co.number, co.title, co.status, k.kind, k.title AS contract_title FROM change_orders co JOIN contracts k ON k.id = co.contract_id WHERE co.change_event_id = $1 ORDER BY co.number`,
      [row.id],
    );
    return { ...row, lines, changeOrders: cos, myRole: access.role };
  });

  app.patch<Id>("/change-events/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string }>(db, "change_events", req.params.id, user.id, "record.write", "Change event");
    if (row.status !== "open") throw new HttpError(409, "Only open change events can be edited");
    const b = editable(ceInput).extend({ status: z.enum(["open", "closed", "void"]).optional() }).parse(req.body);
    if (b.status && b.status !== "open" && access.role !== "admin" && access.role !== "manager") throw new HttpError(403, "Only a manager can close or void a change event");
    return db.tx(async (q) => {
      await q.query(
        `UPDATE change_events SET title = coalesce($2, title), description = coalesce($3, description), reason = coalesce($4, reason), scope = coalesce($5, scope), status = coalesce($6, status) WHERE id = $1`,
        [row.id, b.title ?? null, b.description ?? null, b.reason ?? null, b.scope ?? null, b.status ?? null],
      );
      if (b.lines) {
        await assertCostCodes(q, row.project_id, b.lines.map((l) => l.costCodeId));
        await writeCeLines(q, row.id, b.lines);
      }
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "change_event.update", entityType: "change_event", entityId: row.id, detail: { ...b, lines: b.lines?.length } });
      return { ok: true };
    });
  });

  // ---------- Change orders ----------

  const coInput = z.object({
    contractId: z.uuid(),
    changeEventId: z.uuid().nullable().optional(),
    title: z.string().trim().min(1).max(300),
    description: optText(10000),
    scheduleImpactDays: z.number().int().min(-3650).max(3650).default(0),
    lines: z.array(line).min(1).max(200),
  });

  app.get<P>("/projects/:projectId/change-orders", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT co.id, co.number, co.title, co.status, co.schedule_impact_days, k.kind, k.title AS contract_title, k.counterparty,
              coalesce(sum(l.amount), 0)::text AS amount, ce.number AS change_event_number
         FROM change_orders co JOIN contracts k ON k.id = co.contract_id LEFT JOIN change_order_lines l ON l.change_order_id = co.id
         LEFT JOIN change_events ce ON ce.id = co.change_event_id
        WHERE co.project_id = $1 GROUP BY co.id, k.id, ce.number ORDER BY co.number DESC`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/change-orders", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = coInput.parse(req.body);
    const co = await db.tx(async (q) => {
      const [k] = await q.query<{ status: string }>("SELECT status FROM contracts WHERE id = $1 AND project_id = $2", [b.contractId, project.id]);
      if (!k) throw new HttpError(400, "Contract not found in this project");
      if (k.status !== "approved") throw new HttpError(409, "Change orders can only be added to approved contracts");
      if (b.changeEventId && !(await q.query("SELECT 1 FROM change_events WHERE id = $1 AND project_id = $2 AND status = 'open'", [b.changeEventId, project.id])).length) {
        throw new HttpError(400, "Change event not found or not open");
      }
      await assertCostCodes(q, project.id, b.lines.map((l) => l.costCodeId));
      const number = await nextNumber(q, "change_orders", project.id);
      const [row] = await q.query<{ id: string }>(
        `INSERT INTO change_orders (project_id, contract_id, number, change_event_id, title, description, schedule_impact_days, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, number`,
        [project.id, b.contractId, number, b.changeEventId ?? null, b.title, b.description ?? null, b.scheduleImpactDays, user.id],
      );
      await writeLines(q, "change_order_lines", "change_order_id", row!.id, b.lines);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "change_order.create", entityType: "change_order", entityId: row!.id, detail: { number, title: b.title, amount: fmt(sum(b.lines.map((l) => l.amount))) } });
      return row!;
    });
    return reply.code(201).send(co);
  });

  app.get<Id>("/change-orders/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; contract_id: string }>(db, "change_orders", req.params.id, user.id, "read.full", "Change order");
    const [k] = await db.query("SELECT id, number, kind, title, counterparty FROM contracts WHERE id = $1", [row.contract_id]);
    const lines = await db.query(
      `SELECT l.id, l.seq, l.cost_code_id, c.code AS cost_code, l.description, l.amount::text FROM change_order_lines l JOIN cost_codes c ON c.id = l.cost_code_id WHERE l.change_order_id = $1 ORDER BY l.seq`,
      [row.id],
    );
    return { ...row, contract: k, lines, total: fmt(sum(lines.map((l) => (l as { amount: string }).amount))), approvals: await listSteps(db, "change_order", row.id), myRole: access.role, myId: user.id };
  });

  app.patch<Id>("/change-orders/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string }>(db, "change_orders", req.params.id, user.id, "record.write", "Change order");
    if (row.status !== "draft") throw new HttpError(409, "Only draft change orders can be edited");
    const b = editable(coInput.omit({ contractId: true, changeEventId: true })).parse(req.body);
    return db.tx(async (q) => {
      await q.query(
        `UPDATE change_orders SET title = coalesce($2, title), description = coalesce($3, description), schedule_impact_days = coalesce($4, schedule_impact_days) WHERE id = $1`,
        [row.id, b.title ?? null, b.description ?? null, b.scheduleImpactDays ?? null],
      );
      if (b.lines) {
        await assertCostCodes(q, row.project_id, b.lines.map((l) => l.costCodeId));
        await writeLines(q, "change_order_lines", "change_order_id", row.id, b.lines);
      }
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "change_order.update", entityType: "change_order", entityId: row.id, detail: { ...b, lines: b.lines?.length } });
      return { ok: true };
    });
  });

  app.post<Id>("/change-orders/:id/submit", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number; title: string }>(db, "change_orders", req.params.id, user.id, "record.write", "Change order");
    if (!["draft", "rejected"].includes(row.status)) throw new HttpError(409, "Only draft or rejected change orders can be submitted");
    const b = z.object({ approverIds: z.array(z.uuid()).min(1).max(10) }).parse(req.body);
    return db.tx(async (q) => {
      for (const id of b.approverIds) {
        await assertProjectMember(q, row.project_id, id, "Approver");
        if (!(await canManage(q, row.project_id, id))) throw new HttpError(400, "Change order approvers must be project managers or company admins");
      }
      await startRound(q, "change_order", row.id, b.approverIds);
      await q.query("UPDATE change_orders SET status = 'pending' WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "change_order.submit", entityType: "change_order", entityId: row.id, detail: { number: row.number } });
      await config.notify(q, [b.approverIds[0]], { kind: "approval", title: `Change order #${row.number} needs your approval: ${row.title}`, link: `/change_orders/${row.id}`, projectId: row.project_id, actorId: user.id });
      return { ok: true };
    });
  });

  app.post<Id>("/change-orders/:id/void", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number }>(db, "change_orders", req.params.id, user.id, "record.manage", "Change order");
    if (!["draft", "pending", "rejected"].includes(row.status)) throw new HttpError(409, "Approved change orders cannot be voided; issue a deductive change order instead");
    return db.tx(async (q) => {
      await q.query("UPDATE approval_steps SET status = 'skipped' WHERE entity_type = 'change_order' AND entity_id = $1 AND status = 'pending'", [row.id]);
      await q.query("UPDATE change_orders SET status = 'void', decided_at = now() WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "change_order.void", entityType: "change_order", entityId: row.id, detail: { number: row.number } });
      return { ok: true };
    });
  });

  // ---------- Invoices / pay applications ----------

  app.get<P>("/projects/:projectId/invoices", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    const rows = await db.query<{ id: string }>(
      `SELECT i.id, i.number, i.period_start, i.period_end, i.status, k.kind, k.title AS contract_title, k.counterparty
         FROM invoices i JOIN contracts k ON k.id = i.contract_id WHERE i.project_id = $1 ORDER BY i.created_at DESC`,
      [req.params.projectId],
    );
    const out = [];
    for (const r of rows) {
      const pa = await computePayApp(db, r.id);
      out.push({ ...r, completed_to_date: pa.totals.completed_to_date, current_payment_due: pa.totals.current_payment_due, retainage: pa.totals.retainage });
    }
    return out;
  });

  app.post<P>("/projects/:projectId/invoices", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({ contractId: z.uuid(), periodStart: z.iso.date(), periodEnd: z.iso.date() }).parse(req.body);
    if (b.periodEnd < b.periodStart) throw new HttpError(400, "Period end is before period start");
    const inv = await db.tx(async (q) => {
      const [k] = await q.query<{ status: string }>("SELECT status FROM contracts WHERE id = $1 AND project_id = $2 FOR UPDATE", [b.contractId, project.id]);
      if (!k) throw new HttpError(400, "Contract not found in this project");
      if (k.status !== "approved") throw new HttpError(409, "Invoices can only be created on approved contracts");
      if ((await q.query("SELECT 1 FROM invoices WHERE contract_id = $1 AND status IN ('draft','submitted','rejected')", [b.contractId])).length) {
        throw new HttpError(409, "Finish or delete the open invoice on this contract first");
      }
      const [overlap] = await q.query("SELECT 1 FROM invoices WHERE contract_id = $1 AND status IN ('approved','paid') AND period_end >= $2", [b.contractId, b.periodStart]);
      if (overlap) throw new HttpError(400, "This period overlaps an approved invoice");
      const number = await nextNumber(q, "invoices", project.id);
      const [row] = await q.query<{ id: string }>(
        `INSERT INTO invoices (project_id, contract_id, number, period_start, period_end, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, number`,
        [project.id, b.contractId, number, b.periodStart, b.periodEnd, user.id],
      );
      for (const s of await scheduleOfValues(q, b.contractId)) {
        await q.query("INSERT INTO invoice_lines (invoice_id, contract_line_id, change_order_line_id) VALUES ($1, $2, $3)", [row!.id, s.contract_line_id, s.change_order_line_id]);
      }
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "invoice.create", entityType: "invoice", entityId: row!.id, detail: { number, period: [b.periodStart, b.periodEnd] } });
      return row!;
    });
    return reply.code(201).send(inv);
  });

  app.get<Id>("/invoices/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; contract_id: string }>(db, "invoices", req.params.id, user.id, "read.full", "Invoice");
    const pa = await computePayApp(db, row.id);
    const [k] = await db.query("SELECT id, number, kind, title, counterparty FROM contracts WHERE id = $1", [row.contract_id]);
    return { ...pa, contract: k, approvals: await listSteps(db, "invoice", row.id), myRole: access.role, myId: user.id };
  });

  app.get<Id>("/invoices/:id/g703.csv", async (req, reply) => {
    const user = requireUser(req);
    const { row } = await loadInProject<{ project_id: string; id: string; number: number }>(db, "invoices", req.params.id, user.id, "read.full", "Invoice");
    const pa = await computePayApp(db, row.id);
    const headers = ["Cost code", "Description", "Source", "Scheduled value", "From previous application", "This period", "Materials presently stored", "Completed and stored to date", "% complete", "Balance to finish", "Retainage"];
    const data = pa.lines.map((l) => [l.cost_code, l.description, l.source, l.scheduled_value, l.previous_work, l.work_this_period, l.materials_stored, l.completed_to_date, l.percent_complete, l.balance_to_finish, l.retainage]);
    data.push(["", "TOTAL", "", pa.totals.contract_sum_to_date, "", "", "", pa.totals.completed_to_date, "", "", pa.totals.retainage]);
    data.push([], ["", "Current payment due", "", pa.totals.current_payment_due]);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="pay-application-${row.number}.csv"`);
    return toCsv(headers, data);
  });

  app.put<Id>("/invoices/:id/lines", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string }>(db, "invoices", req.params.id, user.id, "record.write", "Invoice");
    if (!["draft", "rejected"].includes(row.status)) throw new HttpError(409, "Only draft or rejected invoices can be edited");
    const b = z.object({
      lines: z.array(z.object({ key: z.string().regex(/^(cl|col):[0-9a-f-]{36}$/), workThisPeriod: nonNegativeMoney, materialsStored: nonNegativeMoney.default("0.00") })).max(1000),
    }).parse(req.body);
    return db.tx(async (q) => {
      for (const l of b.lines) {
        const [kind, id] = l.key.split(":") as ["cl" | "col", string];
        const col = kind === "cl" ? "contract_line_id" : "change_order_line_id";
        const r = await q.query(`UPDATE invoice_lines SET work_this_period = $3, materials_stored = $4 WHERE invoice_id = $1 AND ${col} = $2 RETURNING id`, [row.id, id, l.workThisPeriod, l.materialsStored]);
        if (!r.length) throw new HttpError(400, "A line does not belong to this invoice");
      }
      if (row.status === "rejected") await q.query("UPDATE invoices SET status = 'draft' WHERE id = $1", [row.id]);
      const pa = await computePayApp(q, row.id);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "invoice.lines", entityType: "invoice", entityId: row.id, detail: { completed: pa.totals.completed_to_date, due: pa.totals.current_payment_due } });
      return pa;
    });
  });

  app.post<Id>("/invoices/:id/submit", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number }>(db, "invoices", req.params.id, user.id, "record.write", "Invoice");
    if (row.status !== "draft") throw new HttpError(409, "Only draft invoices can be submitted");
    const b = z.object({ approverIds: z.array(z.uuid()).min(1).max(10) }).parse(req.body);
    return db.tx(async (q) => {
      const pa = await computePayApp(q, row.id);
      if (pa.overbilled.length) throw new HttpError(400, `Billing exceeds the scheduled value on: ${pa.overbilled.join("; ")}`);
      if (dec(pa.totals.current_payment_due).isZero() && dec(pa.totals.completed_to_date).isZero()) throw new HttpError(400, "Enter work completed before submitting");
      for (const id of b.approverIds) {
        await assertProjectMember(q, row.project_id, id, "Approver");
        if (!(await canManage(q, row.project_id, id))) throw new HttpError(400, "Invoice approvers must be project managers or company admins");
      }
      await startRound(q, "invoice", row.id, b.approverIds);
      await q.query("UPDATE invoices SET status = 'submitted' WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "invoice.submit", entityType: "invoice", entityId: row.id, detail: { number: row.number, due: pa.totals.current_payment_due } });
      await config.notify(q, [b.approverIds[0]], { kind: "approval", title: `Invoice #${row.number} needs your approval (${pa.totals.current_payment_due} due)`, link: `/invoices/${row.id}`, projectId: row.project_id, actorId: user.id });
      return { ok: true };
    });
  });

  app.post<Id>("/invoices/:id/paid", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number }>(db, "invoices", req.params.id, user.id, "record.manage", "Invoice");
    if (row.status !== "approved") throw new HttpError(409, "Only approved invoices can be marked paid");
    return db.tx(async (q) => {
      await q.query("UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "invoice.paid", entityType: "invoice", entityId: row.id, detail: { number: row.number } });
      return { ok: true };
    });
  });

  app.delete<Id>("/invoices/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number }>(db, "invoices", req.params.id, user.id, "record.write", "Invoice");
    if (!["draft", "rejected"].includes(row.status)) throw new HttpError(409, "Only draft or rejected invoices can be deleted");
    return db.tx(async (q) => {
      await q.query("DELETE FROM approval_steps WHERE entity_type = 'invoice' AND entity_id = $1", [row.id]);
      await q.query("DELETE FROM invoices WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "invoice.delete", entityType: "invoice", entityId: row.id, detail: { number: row.number } });
      return { ok: true };
    });
  });
};

async function canManage(q: Queryable, projectId: string, userId: string): Promise<boolean> {
  const r = await q.query(
    `SELECT 1 FROM projects p JOIN org_memberships om ON om.org_id = p.org_id AND om.user_id = $2
       LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.id = $1 AND (om.role IN ('owner','admin') OR pm.role = 'manager')`,
    [projectId, userId],
  );
  return r.length > 0;
}

export function parseCostCodeCsv(csv: string): { code: string; description: string }[] {
  const out: { code: string; description: string }[] = [];
  for (const raw of csv.split(/\r?\n/)) {
    const lineText = raw.trim();
    if (!lineText) continue;
    const m = lineText.match(/^"?([^",]+)"?\s*,\s*"?(.*?)"?$/);
    if (!m) throw new HttpError(400, `Could not read line: ${lineText.slice(0, 80)}`);
    const code = m[1]!.trim();
    const description = m[2]!.trim();
    if (/^code$/i.test(code)) continue; // header
    if (!code || !description || code.length > 40 || description.length > 200) throw new HttpError(400, `Invalid cost code line: ${lineText.slice(0, 80)}`);
    out.push({ code, description });
  }
  return out;
}

function safeName(name: string) {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "project";
}
