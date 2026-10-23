/**
 * Critical-path method over finish-to-start links with optional lag (whole calendar days).
 * Early start = max(planned start, max over predecessors of their early finish + 1 + lag).
 * Late finish = min over successors of (their late start - 1 - lag), or the project finish.
 * Total float = late start - early start; critical when float <= 0.
 */
export interface CpmItem { id: string; start_date: string; end_date: string }
export interface CpmLink { successor_id: string; predecessor_id: string; lag_days: number }
export interface CpmResult { early_start: string; early_finish: string; late_start: string; late_finish: string; total_float: number; critical: boolean }

const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
const iso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** Throws if the links contain a cycle. */
export function assertAcyclic(ids: string[], links: { successor_id: string; predecessor_id: string }[]) {
  const preds = new Map<string, string[]>();
  for (const l of links) preds.set(l.successor_id, [...(preds.get(l.successor_id) ?? []), l.predecessor_id]);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error("Dependency loop");
    state.set(id, 1);
    for (const p of preds.get(id) ?? []) visit(p);
    state.set(id, 2);
  };
  ids.forEach(visit);
}

export function criticalPath(items: CpmItem[], links: CpmLink[]): Map<string, CpmResult> {
  const ids = new Set(items.map((i) => i.id));
  const valid = links.filter((l) => ids.has(l.successor_id) && ids.has(l.predecessor_id));
  assertAcyclic([...ids], valid);
  const byId = new Map(items.map((i) => [i.id, i]));
  const dur = new Map(items.map((i) => [i.id, day(i.end_date) - day(i.start_date)]));
  const preds = new Map<string, CpmLink[]>();
  const succs = new Map<string, CpmLink[]>();
  for (const l of valid) {
    preds.set(l.successor_id, [...(preds.get(l.successor_id) ?? []), l]);
    succs.set(l.predecessor_id, [...(succs.get(l.predecessor_id) ?? []), l]);
  }
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  const forward = (id: string): number => {
    if (ef.has(id)) return ef.get(id)!;
    const start = Math.max(day(byId.get(id)!.start_date), ...(preds.get(id) ?? []).map((l) => forward(l.predecessor_id) + 1 + l.lag_days));
    es.set(id, start);
    ef.set(id, start + dur.get(id)!);
    return ef.get(id)!;
  };
  items.forEach((i) => forward(i.id));
  const projectFinish = Math.max(...items.map((i) => ef.get(i.id)!));
  const lf = new Map<string, number>();
  const backward = (id: string): number => {
    if (lf.has(id)) return lf.get(id)!;
    const s = succs.get(id) ?? [];
    const finish = s.length ? Math.min(...s.map((l) => backward(l.successor_id) - dur.get(l.successor_id)! - 1 - l.lag_days)) : projectFinish;
    lf.set(id, finish);
    return finish;
  };
  const out = new Map<string, CpmResult>();
  for (const i of items) {
    const f = backward(i.id);
    const ls = f - dur.get(i.id)!;
    const totalFloat = ls - es.get(i.id)!;
    out.set(i.id, { early_start: iso(es.get(i.id)!), early_finish: iso(ef.get(i.id)!), late_start: iso(ls), late_finish: iso(f), total_float: totalFloat, critical: totalFloat <= 0 });
  }
  return out;
}
