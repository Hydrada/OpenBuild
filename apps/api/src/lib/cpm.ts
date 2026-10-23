/**
 * Critical-path method over finish-to-start links (one predecessor per activity, as modelled).
 * Works in whole calendar days. Early dates respect the planned start and the predecessor's early finish;
 * late dates come from the backward pass against the project finish. Total float = late start - early start.
 */
export interface CpmInput { id: string; start_date: string; end_date: string; predecessor_id: string | null }
export interface CpmResult { early_start: string; early_finish: string; late_start: string; late_finish: string; total_float: number; critical: boolean }

const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
const iso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

export function criticalPath(items: CpmInput[]): Map<string, CpmResult> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const dur = new Map(items.map((i) => [i.id, day(i.end_date) - day(i.start_date)]));
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  const visit = (id: string, depth = 0): number => {
    if (ef.has(id)) return ef.get(id)!;
    if (depth > items.length) throw new Error("Dependency loop");
    const it = byId.get(id)!;
    const pred = it.predecessor_id && byId.has(it.predecessor_id) ? visit(it.predecessor_id, depth + 1) + 1 : -Infinity;
    const start = Math.max(day(it.start_date), pred);
    es.set(id, start);
    ef.set(id, start + dur.get(id)!);
    return ef.get(id)!;
  };
  items.forEach((i) => visit(i.id));
  const projectFinish = Math.max(...items.map((i) => ef.get(i.id)!));
  const successors = new Map<string, string[]>();
  for (const i of items) if (i.predecessor_id && byId.has(i.predecessor_id)) successors.set(i.predecessor_id, [...(successors.get(i.predecessor_id) ?? []), i.id]);
  const lf = new Map<string, number>();
  const back = (id: string): number => {
    if (lf.has(id)) return lf.get(id)!;
    const succ = successors.get(id) ?? [];
    const finish = succ.length ? Math.min(...succ.map((s) => back(s) - dur.get(s)! - 1)) : projectFinish;
    lf.set(id, finish);
    return finish;
  };
  const out = new Map<string, CpmResult>();
  for (const i of items) {
    const f = back(i.id);
    const ls = f - dur.get(i.id)!;
    const totalFloat = ls - es.get(i.id)!;
    out.set(i.id, { early_start: iso(es.get(i.id)!), early_finish: iso(ef.get(i.id)!), late_start: iso(ls), late_finish: iso(f), total_float: totalFloat, critical: totalFloat <= 0 });
  }
  return out;
}
