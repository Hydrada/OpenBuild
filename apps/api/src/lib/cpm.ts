/**
 * Critical-path method in working days (see WorkCalendar; default: every day works). Link types (predecessor P → successor S, lag L):
 *   FS: S.start ≥ P.finish + 1 + L     SS: S.start ≥ P.start + L
 *   FF: S.finish ≥ P.finish + L        SF: S.finish ≥ P.start + L
 * Early dates: forward pass from planned starts. Late dates: backward pass from the project finish.
 * Total float = late start - early start; critical when float <= 0.
 */
export type LinkType = "FS" | "SS" | "FF" | "SF";
export interface CpmItem { id: string; start_date: string; end_date: string }
export interface CpmLink { successor_id: string; predecessor_id: string; lag_days: number; link_type?: LinkType }
export interface CpmResult { early_start: string; early_finish: string; late_start: string; late_finish: string; total_float: number; critical: boolean }

const calDay = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
const calIso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** Working calendar: worked weekdays (0 = Sunday) and non-working dates. Default: every day works. */
export interface WorkCalendar { workDays: number[]; holidays: string[] }

/**
 * Maps calendar dates onto a dense working-day index so CPM can do plain arithmetic.
 * A date that is not a working day maps to the next working day.
 */
function workIndex(cal: WorkCalendar | undefined, from: number, to: number) {
  const work = new Set(cal?.workDays ?? [0, 1, 2, 3, 4, 5, 6]);
  const off = new Set(cal?.holidays ?? []);
  if (!work.size) throw new Error("The calendar has no working days");
  const days: number[] = [];
  const indexOf = new Map<number, number>();
  for (let d = from; d <= to; d++) {
    const ok = work.has(new Date(d * 86_400_000).getUTCDay()) && !off.has(calIso(d));
    indexOf.set(d, days.length); // non-working days point at the next working day
    if (ok) days.push(d);
  }
  return {
    idx: (date: string) => {
      const i = indexOf.get(calDay(date));
      if (i === undefined) throw new Error("Date outside the scheduling window");
      return i;
    },
    /** Working days in [start, end], minus one (a one-day task has duration 0). */
    span: (start: string, end: string) => Math.max(0, (indexOf.get(calDay(end) + 1) ?? days.length) - indexOf.get(calDay(start))! - 1),
    date: (i: number) => calIso(days[Math.max(0, Math.min(i, days.length - 1))]!),
  };
}

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

export function criticalPath(items: CpmItem[], links: CpmLink[], calendar?: WorkCalendar): Map<string, CpmResult> {
  const ids = new Set(items.map((i) => i.id));
  const valid = links.filter((l) => ids.has(l.successor_id) && ids.has(l.predecessor_id));
  assertAcyclic([...ids], valid);
  const byId = new Map(items.map((i) => [i.id, i]));
  // Window wide enough for any reasonable push-out by links and lags.
  const lo = Math.min(...items.map((i) => calDay(i.start_date))) - 3650;
  const hi = Math.max(...items.map((i) => calDay(i.end_date))) + 3650 + valid.reduce((n, l) => n + Math.max(0, l.lag_days), 0) * 2;
  const W = workIndex(calendar, lo, hi);
  const day = W.idx;
  const iso = W.date;
  const dur = new Map(items.map((i) => [i.id, W.span(i.start_date, i.end_date)]));
  const preds = new Map<string, CpmLink[]>();
  const succs = new Map<string, CpmLink[]>();
  for (const l of valid) {
    preds.set(l.successor_id, [...(preds.get(l.successor_id) ?? []), l]);
    succs.set(l.predecessor_id, [...(succs.get(l.predecessor_id) ?? []), l]);
  }
  const es = new Map<string, number>();
  const forward = (id: string): number => {
    if (es.has(id)) return es.get(id)!;
    const d = dur.get(id)!;
    const bounds = (preds.get(id) ?? []).map((l) => {
      const pes = forward(l.predecessor_id);
      const pef = pes + dur.get(l.predecessor_id)!;
      switch (l.link_type ?? "FS") {
        case "SS": return pes + l.lag_days;
        case "FF": return pef + l.lag_days - d;
        case "SF": return pes + l.lag_days - d;
        default: return pef + 1 + l.lag_days;
      }
    });
    const start = Math.max(day(byId.get(id)!.start_date), ...bounds);
    es.set(id, start);
    return start;
  };
  items.forEach((i) => forward(i.id));
  const ef = (id: string) => es.get(id)! + dur.get(id)!;
  const projectFinish = Math.max(...items.map((i) => ef(i.id)));
  const lf = new Map<string, number>();
  const backward = (id: string): number => {
    if (lf.has(id)) return lf.get(id)!;
    const d = dur.get(id)!;
    const bounds = (succs.get(id) ?? []).map((l) => {
      const slf = backward(l.successor_id);
      const sls = slf - dur.get(l.successor_id)!;
      switch (l.link_type ?? "FS") {
        case "SS": return sls - l.lag_days + d; // our start ≤ successor late start - lag
        case "FF": return slf - l.lag_days;
        case "SF": return slf - l.lag_days + d; // our start ≤ successor late finish - lag
        default: return sls - 1 - l.lag_days;
      }
    });
    const finish = Math.min(projectFinish, ...bounds);
    lf.set(id, finish);
    return finish;
  };
  const out = new Map<string, CpmResult>();
  for (const i of items) {
    const f = backward(i.id);
    const ls = f - dur.get(i.id)!;
    const totalFloat = ls - es.get(i.id)!;
    out.set(i.id, { early_start: iso(es.get(i.id)!), early_finish: iso(ef(i.id)), late_start: iso(ls), late_finish: iso(f), total_float: totalFloat, critical: totalFloat <= 0 });
  }
  return out;
}
