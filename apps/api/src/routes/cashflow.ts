import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { monthsBetween, spread, type Curve } from "../lib/cashflow.js";
import { HttpError } from "../lib/errors.js";
import { budgetReport, toCsv } from "../lib/finance.js";
import { dec, fmt, sum } from "../lib/money.js";
import { isUuid, requireProject } from "../lib/permissions.js";

type P = { Params: { projectId: string } };

/**
 * Monthly cash flow: each cost code's estimate at completion spread over its months by curve (forecast), against
 * actual cost by month — approved direct costs on their date and approved/paid commitment invoices (work + stored)
 * in their period's month.
 */
export const cashFlowRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  async function cashFlow(projectId: string) {
    const [proj] = await db.query<{ start_date: string | null; end_date: string | null }>("SELECT start_date, end_date FROM projects WHERE id = $1", [projectId]);
    const report = await budgetReport(db, projectId);
    const spreads = new Map((await db.query<{ cost_code_id: string; spread_start: string | null; spread_end: string | null; spread_curve: Curve }>(
      "SELECT cost_code_id, spread_start, spread_end, spread_curve FROM budget_lines WHERE project_id = $1", [projectId])).map((s) => [s.cost_code_id, s]));
    const actualRows = await db.query<{ cost_code_id: string; month: string; amount: string }>(
      `SELECT cost_code_id, month, sum(amount)::text AS amount FROM (
         SELECT d.cost_code_id, to_char(d.cost_date, 'YYYY-MM') AS month, d.amount FROM direct_costs d WHERE d.project_id = $1 AND d.status = 'approved'
         UNION ALL
         SELECT coalesce(cl.cost_code_id, col.cost_code_id), to_char(i.period_end, 'YYYY-MM'), il.work_this_period + il.materials_stored
           FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id JOIN contracts k ON k.id = i.contract_id
           LEFT JOIN contract_lines cl ON cl.id = il.contract_line_id LEFT JOIN change_order_lines col ON col.id = il.change_order_line_id
          WHERE i.project_id = $1 AND k.kind <> 'prime' AND i.status IN ('approved','paid')
       ) x GROUP BY 1, 2`, [projectId]);
    const fallbackStart = proj?.start_date ?? new Date().toISOString().slice(0, 10);
    const fallbackEnd = proj?.end_date ?? fallbackStart;
    const rows = report.rows.map((r) => {
      const s = spreads.get(r.cost_code_id);
      const start = s?.spread_start ?? fallbackStart, end = s?.spread_end ?? fallbackEnd;
      const months = monthsBetween(start, end < start ? start : end);
      const parts = spread(r.estimated_cost_at_completion, s?.spread_curve ?? "linear", months.length);
      return {
        cost_code_id: r.cost_code_id, cost_code: r.cost_code, description: r.description, eac: r.estimated_cost_at_completion,
        spread: { start: start.slice(0, 7), end: end.slice(0, 7), curve: s?.spread_curve ?? "linear", set: !!(s?.spread_start && s?.spread_end) },
        forecast: Object.fromEntries(months.map((m, i) => [m, parts[i]!])),
        actual: Object.fromEntries(actualRows.filter((a) => a.cost_code_id === r.cost_code_id).map((a) => [a.month, fmt(dec(a.amount))])),
      };
    });
    const allMonths = [...new Set(rows.flatMap((r) => [...Object.keys(r.forecast), ...Object.keys(r.actual)]))].sort();
    const months = allMonths.length ? monthsBetween(`${allMonths[0]}-01`, `${allMonths[allMonths.length - 1]}-01`) : [];
    let cumF = dec(0), cumA = dec(0);
    const totals = months.map((m) => {
      const f = sum(rows.map((r) => r.forecast[m] ?? "0")), a = sum(rows.map((r) => r.actual[m] ?? "0"));
      cumF = cumF.plus(f); cumA = cumA.plus(a);
      return { month: m, forecast: fmt(f), actual: fmt(a), cumulative_forecast: fmt(cumF), cumulative_actual: fmt(cumA) };
    });
    return { months, rows, totals };
  }

  app.get<P>("/projects/:projectId/cash-flow", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return cashFlow(req.params.projectId);
  });

  app.get<P>("/projects/:projectId/cash-flow.csv", async (req, reply) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    const c = await cashFlow(req.params.projectId);
    const data: string[][] = [];
    for (const r of c.rows) {
      data.push([r.cost_code, r.description, "Forecast", ...c.months.map((m) => r.forecast[m] ?? "")]);
      data.push([r.cost_code, r.description, "Actual", ...c.months.map((m) => r.actual[m] ?? "")]);
    }
    data.push(["TOTAL", "", "Forecast", ...c.totals.map((t) => t.forecast)], ["TOTAL", "", "Actual", ...c.totals.map((t) => t.actual)]);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="cash-flow.csv"');
    return toCsv(["Cost code", "Description", "Series", ...c.months], data);
  });

  app.put<{ Params: { projectId: string; costCodeId: string } }>("/projects/:projectId/budget/lines/:costCodeId/spread", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    if (!isUuid(req.params.costCodeId)) throw new HttpError(404, "Cost code not found");
    const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");
    const b = z.object({ start: month, end: month, curve: z.enum(["linear", "front", "back", "s_curve"]) }).parse(req.body);
    if (b.end < b.start) throw new HttpError(400, "The spread ends before it starts");
    if (monthsBetween(`${b.start}-01`, `${b.end}-01`).length > 120) throw new HttpError(400, "Spreads are limited to 10 years");
    if (!(await db.query("SELECT 1 FROM cost_codes WHERE id = $1 AND project_id = $2", [req.params.costCodeId, project.id])).length) throw new HttpError(404, "Cost code not found");
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO budget_lines (project_id, cost_code_id, spread_start, spread_end, spread_curve) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, cost_code_id) DO UPDATE SET spread_start = EXCLUDED.spread_start, spread_end = EXCLUDED.spread_end, spread_curve = EXCLUDED.spread_curve`,
        [project.id, req.params.costCodeId, `${b.start}-01`, `${b.end}-01`, b.curve]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "budget.spread", entityType: "project", entityId: project.id, detail: { costCodeId: req.params.costCodeId, ...b } });
    });
    return { ok: true };
  });
};
