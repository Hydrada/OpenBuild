import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { toCsv } from "../lib/finance.js";
import { D, dec, fmt, nonNegativeMoney, pctOf, sum } from "../lib/money.js";
import { isUuid, requireOrgRole, requireProject } from "../lib/permissions.js";
import { loadInProject } from "../lib/records.js";

const category = z.enum(["labor", "material", "equipment", "subcontract", "other"]);
const qty = z.union([z.number(), z.string()]).transform(String).pipe(z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "Quantity must be a non-negative number with up to 3 decimals"));
const pct = z.union([z.number(), z.string()]).transform(String).pipe(z.string().regex(/^\d{1,3}(\.\d{1,3})?$/)).refine((v) => Number(v) <= 100, "Percent must be 0-100");

interface Line { id: string; seq: number; cost_code_id: string | null; cost_code: string | null; cost_code_description: string | null; description: string; category: string; quantity: string; unit: string | null; unit_cost: string }

/**
 * Direct cost = Σ round(qty × unit cost) per line (half-even). Markups compound in the usual order:
 * overhead and contingency on direct cost, profit on (direct + overhead + contingency), bond on the subtotal with profit.
 * Each markup is allocated to cost codes in proportion to their direct cost, with the rounding remainder on the largest.
 */
export function estimateTotals(lines: Line[], p: { overhead_pct: string; contingency_pct: string; profit_pct: string; bond_pct: string }) {
  const priced = lines.map((l) => ({ ...l, amount: fmt(dec(l.quantity).times(dec(l.unit_cost))) }));
  const direct = sum(priced.map((l) => l.amount));
  const overhead = pctOf(direct, p.overhead_pct);
  const contingency = pctOf(direct, p.contingency_pct);
  const profit = pctOf(direct.plus(overhead).plus(contingency), p.profit_pct);
  const bond = pctOf(direct.plus(overhead).plus(contingency).plus(profit), p.bond_pct);
  const total = direct.plus(overhead).plus(contingency).plus(profit).plus(bond);
  const markup = total.minus(direct);
  const byCode = new Map<string, { cost_code_id: string | null; cost_code: string; description: string; direct: InstanceType<typeof D> }>();
  for (const l of priced) {
    const k = l.cost_code_id ?? "none";
    const cur = byCode.get(k) ?? { cost_code_id: l.cost_code_id, cost_code: l.cost_code ?? "Uncoded", description: l.cost_code_description ?? "", direct: new D(0) };
    cur.direct = cur.direct.plus(l.amount);
    byCode.set(k, cur);
  }
  const groups = [...byCode.values()].sort((a, b) => a.cost_code.localeCompare(b.cost_code));
  const alloc = groups.map((g) => (direct.isZero() ? new D(0) : markup.times(g.direct).div(direct).toDecimalPlaces(2, D.ROUND_HALF_EVEN)));
  const remainder = markup.minus(sum(alloc.map((a) => a.toFixed(2))));
  if (groups.length && !remainder.isZero()) {
    const biggest = groups.reduce((bi, g, i) => (g.direct.gt(groups[bi]!.direct) ? i : bi), 0);
    alloc[biggest] = alloc[biggest]!.plus(remainder);
  }
  return {
    lines: priced,
    totals: { direct: fmt(direct), overhead: fmt(overhead), contingency: fmt(contingency), profit: fmt(profit), bond: fmt(bond), total: fmt(total) },
    byCostCode: groups.map((g, i) => ({ cost_code_id: g.cost_code_id, cost_code: g.cost_code, description: g.description, direct: fmt(g.direct), with_markup: fmt(g.direct.plus(alloc[i]!)) })),
  };
}

export const estimateRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  // ---------- Cost catalog ----------
  const itemInput = z.object({ code: z.string().trim().max(40).nullable().optional(), name: z.string().trim().min(1).max(200), category: category.default("material"), unit: z.string().trim().min(1).max(20), unitCost: nonNegativeMoney });

  app.get<{ Params: { orgId: string } }>("/orgs/:orgId/cost-catalog", async (req) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    return db.query("SELECT id, code, name, category, unit, unit_cost::text FROM cost_catalog_items WHERE org_id = $1 ORDER BY category, name", [req.params.orgId]);
  });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/cost-catalog", async (req, reply) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const b = itemInput.parse(req.body);
    if ((await db.query("SELECT 1 FROM cost_catalog_items WHERE org_id = $1 AND lower(name) = lower($2)", [req.params.orgId, b.name])).length) throw new HttpError(409, "An item with that name already exists");
    const [r] = await db.query<{ id: string }>("INSERT INTO cost_catalog_items (org_id, code, name, category, unit, unit_cost) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [req.params.orgId, b.code ?? null, b.name, b.category, b.unit, b.unitCost]);
    return reply.code(201).send(r);
  });

  app.delete<{ Params: { id: string } }>("/cost-catalog/:id", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.id)) throw new HttpError(404, "Item not found");
    const [i] = await db.query<{ org_id: string }>("SELECT org_id FROM cost_catalog_items WHERE id = $1", [req.params.id]);
    if (!i) throw new HttpError(404, "Item not found");
    try { await requireOrgRole(db, user.id, i.org_id, ["owner", "admin"]); } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new HttpError(404, "Item not found");
      throw e;
    }
    await db.query("DELETE FROM cost_catalog_items WHERE id = $1", [req.params.id]);
    return { ok: true };
  });

  // ---------- Estimates ----------
  async function detail(q: Queryable, id: string) {
    const [e] = await q.query<{ id: string; project_id: string; overhead_pct: string; contingency_pct: string; profit_pct: string; bond_pct: string }>(
      "SELECT id, project_id, name, status, overhead_pct::text, contingency_pct::text, profit_pct::text, bond_pct::text, sent_to_budget_at, created_at FROM estimates WHERE id = $1", [id]);
    const lines = await q.query<Line>(
      `SELECT l.id, l.seq, l.cost_code_id, c.code AS cost_code, c.description AS cost_code_description, l.description, l.category, l.quantity::text, l.unit, l.unit_cost::text
         FROM estimate_lines l LEFT JOIN cost_codes c ON c.id = l.cost_code_id WHERE l.estimate_id = $1 ORDER BY l.seq`, [id]);
    return { ...e!, ...estimateTotals(lines, e!) };
  }

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/estimates", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    const rows = await db.query<{ id: string }>("SELECT id FROM estimates WHERE project_id = $1 ORDER BY created_at DESC", [req.params.projectId]);
    const out = [];
    for (const r of rows) {
      const d = await detail(db, r.id);
      out.push({ id: d.id, name: (d as unknown as { name: string }).name, status: (d as unknown as { status: string }).status, total: d.totals.total, direct: d.totals.direct, lines: d.lines.length, sent_to_budget_at: (d as unknown as { sent_to_budget_at: string | null }).sent_to_budget_at });
    }
    return out;
  });

  const settings = z.object({ name: z.string().trim().min(1).max(200), overheadPct: pct, contingencyPct: pct, profitPct: pct, bondPct: pct });

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/estimates", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = settings.partial({ overheadPct: true, contingencyPct: true, profitPct: true, bondPct: true }).parse(req.body);
    if ((await db.query("SELECT 1 FROM estimates WHERE project_id = $1 AND lower(name) = lower($2)", [project.id, b.name])).length) throw new HttpError(409, "An estimate with that name already exists");
    const [e] = await db.query<{ id: string }>(
      "INSERT INTO estimates (project_id, name, overhead_pct, contingency_pct, profit_pct, bond_pct, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [project.id, b.name, b.overheadPct ?? "0", b.contingencyPct ?? "0", b.profitPct ?? "0", b.bondPct ?? "0", user.id]);
    await audit(db, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "estimate.create", entityType: "estimate", entityId: e!.id, detail: { name: b.name } });
    return reply.code(201).send(e);
  });

  app.get<{ Params: { id: string } }>("/estimates/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "estimates", req.params.id, user.id, "read.full", "Estimate");
    return { ...(await detail(db, row.id)), myRole: access.role };
  });

  /** Replace settings and/or lines while the estimate is a draft. */
  app.put<{ Params: { id: string } }>("/estimates/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string }>(db, "estimates", req.params.id, user.id, "record.write", "Estimate");
    if (row.status === "final") throw new HttpError(409, "A final estimate cannot be changed");
    const b = settings.partial().extend({
      lines: z.array(z.object({ costCodeId: z.uuid().nullable().optional(), description: z.string().trim().min(1).max(500), category: category.default("material"), quantity: qty, unit: z.string().trim().max(20).nullable().optional(), unitCost: nonNegativeMoney })).max(2000).optional(),
    }).parse(req.body);
    return db.tx(async (q) => {
      await q.query(
        `UPDATE estimates SET name = coalesce($2, name), overhead_pct = coalesce($3, overhead_pct), contingency_pct = coalesce($4, contingency_pct),
                profit_pct = coalesce($5, profit_pct), bond_pct = coalesce($6, bond_pct) WHERE id = $1`,
        [row.id, b.name ?? null, b.overheadPct ?? null, b.contingencyPct ?? null, b.profitPct ?? null, b.bondPct ?? null]);
      if (b.lines) {
        const codes = [...new Set(b.lines.map((l) => l.costCodeId).filter((x): x is string => !!x))];
        if (codes.length && (await q.query("SELECT id FROM cost_codes WHERE project_id = $1 AND id = ANY($2::uuid[])", [row.project_id, codes])).length !== codes.length) throw new HttpError(400, "Unknown cost code");
        await q.query("DELETE FROM estimate_lines WHERE estimate_id = $1", [row.id]);
        let seq = 0;
        for (const l of b.lines) {
          await q.query("INSERT INTO estimate_lines (estimate_id, seq, cost_code_id, description, category, quantity, unit, unit_cost) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            [row.id, ++seq, l.costCodeId ?? null, l.description, l.category, l.quantity, l.unit ?? null, l.unitCost]);
        }
      }
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "estimate.update", entityType: "estimate", entityId: row.id, detail: { lines: b.lines?.length } });
      return detail(q, row.id);
    });
  });

  /** Finalize and write each cost code's total (with markup) as the original budget. Refused if the budget is locked. */
  app.post<{ Params: { id: string } }>("/estimates/:id/send-to-budget", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "estimates", req.params.id, user.id, "record.manage", "Estimate");
    return db.tx(async (q) => {
      const [lock] = await q.query<{ l: boolean }>("SELECT bool_or(locked) AS l FROM budget_lines WHERE project_id = $1", [row.project_id]);
      if (lock?.l) throw new HttpError(409, "The budget is locked; use budget modifications instead");
      const d = await detail(q, row.id);
      const uncoded = d.lines.filter((l) => !l.cost_code_id);
      if (uncoded.length) throw new HttpError(400, `Give every line a cost code first (${uncoded.length} without)`);
      for (const g of d.byCostCode) {
        await q.query(
          `INSERT INTO budget_lines (project_id, cost_code_id, original_amount) VALUES ($1, $2, $3)
           ON CONFLICT (project_id, cost_code_id) DO UPDATE SET original_amount = EXCLUDED.original_amount`,
          [row.project_id, g.cost_code_id, g.with_markup]);
      }
      await q.query("UPDATE estimates SET status = 'final', sent_to_budget_at = now() WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "estimate.to_budget", entityType: "estimate", entityId: row.id, detail: { total: d.totals.total, codes: d.byCostCode.length } });
      return { ok: true, total: d.totals.total, costCodes: d.byCostCode.length };
    });
  });

  app.get<{ Params: { id: string } }>("/estimates/:id/csv", async (req, reply) => {
    const user = requireUser(req);
    const { row } = await loadInProject<{ id: string; project_id: string; name: string }>(db, "estimates", req.params.id, user.id, "read.full", "Estimate");
    const d = await detail(db, row.id);
    const rows: (string | null)[][] = d.lines.map((l) => [l.cost_code, l.description, l.category, l.quantity, l.unit, l.unit_cost, l.amount]);
    rows.push([], ["", "Direct cost", "", "", "", "", d.totals.direct], ["", "Overhead", "", "", "", "", d.totals.overhead], ["", "Contingency", "", "", "", "", d.totals.contingency],
      ["", "Profit", "", "", "", "", d.totals.profit], ["", "Bond", "", "", "", "", d.totals.bond], ["", "Total", "", "", "", "", d.totals.total]);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="estimate-${row.name.replace(/[^\w.-]+/g, "_").slice(0, 60)}.csv"`);
    return toCsv(["Cost code", "Description", "Category", "Quantity", "Unit", "Unit cost", "Amount"], rows);
  });
};
