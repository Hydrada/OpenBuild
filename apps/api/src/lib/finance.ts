import type { Queryable } from "../db/db.js";
import { HttpError } from "./errors.js";
import { D, type Dec, dec, fmt, pctOf, sum } from "./money.js";

export interface SovItem {
  key: string;
  contract_line_id: string | null;
  change_order_line_id: string | null;
  cost_code: string;
  description: string;
  scheduled_value: string;
  source: string;
}

/** Schedule of values: the contract's own lines plus lines of its approved change orders. */
export async function scheduleOfValues(q: Queryable, contractId: string): Promise<SovItem[]> {
  return q.query<SovItem>(
    `SELECT 'cl:' || l.id AS key, l.id AS contract_line_id, NULL::uuid AS change_order_line_id, c.code AS cost_code, l.description,
            l.amount::text AS scheduled_value, 'Original contract' AS source, 0 AS ord, l.seq
       FROM contract_lines l JOIN cost_codes c ON c.id = l.cost_code_id WHERE l.contract_id = $1
     UNION ALL
     SELECT 'col:' || l.id, NULL, l.id, c.code, l.description, l.amount::text, 'CO #' || co.number, co.number, l.seq
       FROM change_order_lines l JOIN change_orders co ON co.id = l.change_order_id JOIN cost_codes c ON c.id = l.cost_code_id
      WHERE co.contract_id = $1 AND co.status = 'approved'
     ORDER BY ord, seq`,
    [contractId],
  );
}

export interface PayAppLine {
  key: string;
  cost_code: string;
  description: string;
  source: string;
  scheduled_value: string;
  previous_work: string;
  work_this_period: string;
  materials_stored: string;
  completed_to_date: string;
  percent_complete: string;
  balance_to_finish: string;
  retainage: string;
}

export interface PayApp {
  invoice: Record<string, unknown> & { id: string; contract_id: string; status: string; created_at: string };
  retainage_percent: string;
  lines: PayAppLine[];
  totals: {
    original_contract_sum: string;
    net_change_by_change_orders: string;
    contract_sum_to_date: string;
    completed_to_date: string;
    retainage: string;
    earned_less_retainage: string;
    previous_certificates: string;
    current_payment_due: string;
    balance_to_finish_including_retainage: string;
  };
  overbilled: string[];
}

/**
 * AIA G702/G703-style pay application.
 *  completed_to_date = Σ work from prior approved/paid invoices + work this period + materials presently stored
 *  retainage         = completed_to_date × retainage% (per line, half-even to cents)
 *  previous certs    = what prior approved invoices certified (their completed-to-date less their retainage)
 *  payment due       = earned less retainage − previous certificates
 */
export async function computePayApp(q: Queryable, invoiceId: string): Promise<PayApp> {
  const [invoice] = await q.query<PayApp["invoice"]>("SELECT * FROM invoices WHERE id = $1", [invoiceId]);
  if (!invoice) throw new HttpError(404, "Invoice not found");
  const [contract] = await q.query<{ retainage_percent: string }>("SELECT retainage_percent::text FROM contracts WHERE id = $1", [invoice.contract_id]);
  const pct = dec(contract!.retainage_percent);
  const sov = await scheduleOfValues(q, invoice.contract_id);

  const current = await q.query<{ key: string; work: string; stored: string }>(
    `SELECT coalesce('cl:' || contract_line_id, 'col:' || change_order_line_id) AS key, work_this_period::text AS work, materials_stored::text AS stored
       FROM invoice_lines WHERE invoice_id = $1`,
    [invoiceId],
  );
  // Prior certified invoices are those approved/paid before this one was created.
  const prior = await q.query<{ key: string; work: string }>(
    `SELECT coalesce('cl:' || il.contract_line_id, 'col:' || il.change_order_line_id) AS key, sum(il.work_this_period)::text AS work
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE i.contract_id = $1 AND i.status IN ('approved','paid') AND i.created_at < $2 AND i.id <> $3
      GROUP BY 1`,
    [invoice.contract_id, invoice.created_at, invoiceId],
  );
  const lastPriorStored = await q.query<{ key: string; stored: string }>(
    `SELECT coalesce('cl:' || il.contract_line_id, 'col:' || il.change_order_line_id) AS key, il.materials_stored::text AS stored
       FROM invoice_lines il
      WHERE il.invoice_id = (SELECT id FROM invoices WHERE contract_id = $1 AND status IN ('approved','paid') AND created_at < $2 AND id <> $3 ORDER BY created_at DESC LIMIT 1)`,
    [invoice.contract_id, invoice.created_at, invoiceId],
  );
  const cur = new Map(current.map((r) => [r.key, r]));
  const prevWork = new Map(prior.map((r) => [r.key, dec(r.work)]));
  const prevStored = new Map(lastPriorStored.map((r) => [r.key, dec(r.stored)]));

  const overbilled: string[] = [];
  let previousCertificates: Dec = new D(0);
  const lines: PayAppLine[] = sov.map((s) => {
    const sv = dec(s.scheduled_value);
    const pw = prevWork.get(s.key) ?? new D(0);
    const w = dec(cur.get(s.key)?.work);
    const st = dec(cur.get(s.key)?.stored);
    const g = pw.plus(w).plus(st);
    const ret = pctOf(g, pct);
    const priorG = pw.plus(prevStored.get(s.key) ?? 0);
    previousCertificates = previousCertificates.plus(priorG.minus(pctOf(priorG, pct)));
    if (sv.gte(0) ? g.gt(sv) : g.gt(0)) overbilled.push(`${s.cost_code} ${s.description}`);
    return {
      key: s.key, cost_code: s.cost_code, description: s.description, source: s.source,
      scheduled_value: fmt(sv), previous_work: fmt(pw), work_this_period: fmt(w), materials_stored: fmt(st),
      completed_to_date: fmt(g), percent_complete: sv.isZero() ? "0.00" : fmt(g.div(sv).times(100)),
      balance_to_finish: fmt(sv.minus(g)), retainage: fmt(ret),
    };
  });

  const original = sum(sov.filter((s) => s.contract_line_id).map((s) => s.scheduled_value));
  const changes = sum(sov.filter((s) => s.change_order_line_id).map((s) => s.scheduled_value));
  const completed = sum(lines.map((l) => l.completed_to_date));
  const retainage = sum(lines.map((l) => l.retainage));
  const earned = completed.minus(retainage);
  return {
    invoice,
    retainage_percent: fmt(pct),
    lines,
    totals: {
      original_contract_sum: fmt(original),
      net_change_by_change_orders: fmt(changes),
      contract_sum_to_date: fmt(original.plus(changes)),
      completed_to_date: fmt(completed),
      retainage: fmt(retainage),
      earned_less_retainage: fmt(earned),
      previous_certificates: fmt(previousCertificates),
      current_payment_due: fmt(earned.minus(previousCertificates)),
      balance_to_finish_including_retainage: fmt(original.plus(changes).minus(earned)),
    },
    overbilled,
  };
}

export interface BudgetRow {
  cost_code_id: string;
  cost_code: string;
  description: string;
  original_budget: string;
  budget_modifications: string;
  approved_changes: string;
  revised_budget: string;
  pending_budget_changes: string;
  committed_costs: string;
  pending_cost_changes: string;
  change_event_exposure: string;
  direct_costs: string;
  forecast_to_complete: string | null;
  estimated_cost_at_completion: string;
  projected_over_under: string;
}

/**
 * Budget report per cost code:
 *  revised budget        = original + transfers + approved prime-contract CO lines
 *  committed costs       = approved subcontract/PO lines + their approved CO lines
 *  direct costs (to date)= work + stored materials billed on approved/paid commitment invoices
 *                          + approved direct-cost entries (costs outside any commitment)
 *  estimate at completion= committed + approved direct-cost entries + pending cost changes + forecast_to_complete
 *                          (when set), otherwise the larger of revised budget and that same sum without the forecast
 *  projected over/under  = revised budget − estimate at completion (negative = over budget)
 */
export async function budgetReport(q: Queryable, projectId: string): Promise<{ rows: BudgetRow[]; totals: Omit<BudgetRow, "cost_code_id" | "cost_code" | "description" | "forecast_to_complete"> }> {
  const raw = await q.query<Record<string, string | null> & { cost_code_id: string; cost_code: string; description: string }>(
    `SELECT cc.id AS cost_code_id, cc.code AS cost_code, cc.description,
            coalesce(bl.original_amount, 0)::text AS original_budget,
            bl.forecast_to_complete::text AS forecast_to_complete,
            (coalesce((SELECT sum(amount) FROM budget_modifications m WHERE m.to_cost_code_id = cc.id), 0)
             - coalesce((SELECT sum(amount) FROM budget_modifications m WHERE m.from_cost_code_id = cc.id), 0))::text AS budget_modifications,
            coalesce((SELECT sum(l.amount) FROM change_order_lines l JOIN change_orders co ON co.id = l.change_order_id JOIN contracts k ON k.id = co.contract_id
                       WHERE l.cost_code_id = cc.id AND k.kind = 'prime' AND co.status = 'approved'), 0)::text AS approved_changes,
            coalesce((SELECT sum(l.amount) FROM change_order_lines l JOIN change_orders co ON co.id = l.change_order_id JOIN contracts k ON k.id = co.contract_id
                       WHERE l.cost_code_id = cc.id AND k.kind = 'prime' AND co.status = 'pending'), 0)::text AS pending_budget_changes,
            (coalesce((SELECT sum(l.amount) FROM contract_lines l JOIN contracts k ON k.id = l.contract_id
                        WHERE l.cost_code_id = cc.id AND k.kind <> 'prime' AND k.status IN ('approved','complete')), 0)
             + coalesce((SELECT sum(l.amount) FROM change_order_lines l JOIN change_orders co ON co.id = l.change_order_id JOIN contracts k ON k.id = co.contract_id
                          WHERE l.cost_code_id = cc.id AND k.kind <> 'prime' AND co.status = 'approved'), 0))::text AS committed_costs,
            coalesce((SELECT sum(l.amount) FROM change_order_lines l JOIN change_orders co ON co.id = l.change_order_id JOIN contracts k ON k.id = co.contract_id
                       WHERE l.cost_code_id = cc.id AND k.kind <> 'prime' AND co.status = 'pending'), 0)::text AS pending_cost_changes,
            coalesce((SELECT sum(l.estimated_cost) FROM change_event_lines l JOIN change_events ce ON ce.id = l.change_event_id
                       WHERE l.cost_code_id = cc.id AND ce.status = 'open'
                         AND NOT EXISTS (SELECT 1 FROM change_orders co WHERE co.change_event_id = ce.id AND co.status IN ('pending','approved'))), 0)::text AS change_event_exposure,
            coalesce((SELECT sum(il.work_this_period + il.materials_stored)
                        FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id JOIN contracts k ON k.id = i.contract_id
                        LEFT JOIN contract_lines cl ON cl.id = il.contract_line_id LEFT JOIN change_order_lines col ON col.id = il.change_order_line_id
                       WHERE k.kind <> 'prime' AND i.status IN ('approved','paid') AND coalesce(cl.cost_code_id, col.cost_code_id) = cc.id), 0)::text AS direct_costs,
            coalesce((SELECT sum(d.amount) FROM direct_costs d WHERE d.cost_code_id = cc.id AND d.status = 'approved'), 0)::text AS direct_entries
       FROM cost_codes cc LEFT JOIN budget_lines bl ON bl.cost_code_id = cc.id
      WHERE cc.project_id = $1 ORDER BY cc.code`,
    [projectId],
  );
  // direct_costs above sums stored materials from every approved invoice; stored materials are a balance, so
  // only the latest approved invoice's stored amount counts. Correct for that per cost code:
  const storedOverlap = await q.query<{ cost_code_id: string; extra: string }>(
    `WITH ranked AS (
       SELECT i.id, i.contract_id, row_number() OVER (PARTITION BY i.contract_id ORDER BY i.created_at DESC) AS rn
         FROM invoices i JOIN contracts k ON k.id = i.contract_id
        WHERE i.project_id = $1 AND k.kind <> 'prime' AND i.status IN ('approved','paid'))
     SELECT coalesce(cl.cost_code_id, col.cost_code_id) AS cost_code_id, sum(il.materials_stored)::text AS extra
       FROM invoice_lines il JOIN ranked r ON r.id = il.invoice_id AND r.rn > 1
       LEFT JOIN contract_lines cl ON cl.id = il.contract_line_id LEFT JOIN change_order_lines col ON col.id = il.change_order_line_id
      GROUP BY 1`,
    [projectId],
  );
  const overlap = new Map(storedOverlap.map((r) => [r.cost_code_id, dec(r.extra)]));

  const rows: BudgetRow[] = raw.map((r) => {
    const revised = dec(r.original_budget).plus(dec(r.budget_modifications)).plus(dec(r.approved_changes));
    const committed = dec(r.committed_costs);
    const pendingCost = dec(r.pending_cost_changes);
    const entries = dec(r.direct_entries);
    const eac = r.forecast_to_complete !== null
      ? committed.plus(entries).plus(pendingCost).plus(dec(r.forecast_to_complete))
      : D.max(revised, committed.plus(entries).plus(pendingCost));
    return {
      cost_code_id: r.cost_code_id, cost_code: r.cost_code, description: r.description,
      original_budget: fmt(dec(r.original_budget)), budget_modifications: fmt(dec(r.budget_modifications)),
      approved_changes: fmt(dec(r.approved_changes)), revised_budget: fmt(revised),
      pending_budget_changes: fmt(dec(r.pending_budget_changes)), committed_costs: fmt(committed),
      pending_cost_changes: fmt(pendingCost), change_event_exposure: fmt(dec(r.change_event_exposure)),
      direct_costs: fmt(dec(r.direct_costs).minus(overlap.get(r.cost_code_id) ?? 0).plus(entries)),
      forecast_to_complete: r.forecast_to_complete === null ? null : fmt(dec(r.forecast_to_complete)),
      estimated_cost_at_completion: fmt(eac), projected_over_under: fmt(revised.minus(eac)),
    };
  });
  const keys = ["original_budget", "budget_modifications", "approved_changes", "revised_budget", "pending_budget_changes", "committed_costs", "pending_cost_changes", "change_event_exposure", "direct_costs", "estimated_cost_at_completion", "projected_over_under"] as const;
  const totals = Object.fromEntries(keys.map((k) => [k, fmt(sum(rows.map((r) => r[k])))])) as BudgetReportTotals;
  return { rows, totals };
}
type BudgetReportTotals = Omit<BudgetRow, "cost_code_id" | "cost_code" | "description" | "forecast_to_complete">;

/** RFC 4180 CSV; cells that could be read as formulas by spreadsheet apps are prefixed with a quote. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
