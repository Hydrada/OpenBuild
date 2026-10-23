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

/** `work_days`: actual working days for an already-split activity (its start/end span includes the gaps). */
export interface Assignment { resource_id: string; units: number }
/** `assignments`: resources the activity needs every working day. `resource_id`/`resource_units` are the single-resource shorthand. */
export interface LevelItem extends CpmItem { assignments?: Assignment[]; resource_id?: string | null; resource_units?: number; splittable?: boolean; work_days?: number }

const needs = (i: LevelItem): Assignment[] => i.assignments ?? (i.resource_id ? [{ resource_id: i.resource_id, units: i.resource_units ?? 1 }] : []);
/** `segments` (splittable activities only): contiguous working-day runs as [start, end] pairs. */
export interface LevelResult { start_date: string; end_date: string; delay_days: number; segments?: [string, string][] }

/**
 * Serial resource levelling. Activities are placed in dependency order, picking the ready activity with the
 * least float and then the earliest CPM start, at the first working day where every link is satisfied (using the
 * already-levelled dates of its predecessors) and its resource has spare capacity for the whole duration.
 * Durations, link types, lags and the calendar are preserved; only start dates move later.
 */
export function levelResources(items: LevelItem[], links: CpmLink[], capacity: Map<string, number>, calendar?: WorkCalendar): { result: Map<string, LevelResult>; finishBefore: string; finishAfter: string } {
  const cpm = criticalPath(items, links, calendar);
  const ids = new Set(items.map((i) => i.id));
  const valid = links.filter((l) => ids.has(l.successor_id) && ids.has(l.predecessor_id));
  const lo = Math.min(...items.map((i) => calDay(i.start_date))) - 3650;
  const hi = Math.max(...items.map((i) => calDay(i.end_date))) + 3650 * 3;
  const W = workIndex(calendar, lo, hi);
  const dur = new Map(items.map((i) => [i.id, i.work_days ? i.work_days - 1 : W.span(i.start_date, i.end_date)]));
  for (const i of items) {
    for (const a of needs(i)) if (a.units > (capacity.get(a.resource_id) ?? 0)) throw new Error(`"${i.id}" needs more units than its resource has`);
  }
  const preds = new Map<string, CpmLink[]>();
  for (const l of valid) preds.set(l.successor_id, [...(preds.get(l.successor_id) ?? []), l]);
  const placed = new Map<string, number>(); // id -> levelled start index
  const usage = new Map<string, Map<number, number>>();
  /** Every assigned resource has spare capacity on every day in [s, s+d]. */
  const fits = (as: Assignment[], s: number, d: number) => as.every((a) => {
    const u = usage.get(a.resource_id) ?? new Map<number, number>();
    const cap = capacity.get(a.resource_id)!;
    for (let t = s; t <= s + d; t++) if ((u.get(t) ?? 0) + a.units > cap) return false;
    return true;
  });
  const book = (as: Assignment[], s: number, d: number) => {
    for (const a of as) {
      const u = usage.get(a.resource_id) ?? new Map<number, number>();
      for (let t = s; t <= s + d; t++) u.set(t, (u.get(t) ?? 0) + a.units);
      usage.set(a.resource_id, u);
    }
  };
  const result = new Map<string, LevelResult>();
  while (placed.size < items.length) {
    const ready = items.filter((i) => !placed.has(i.id) && (preds.get(i.id) ?? []).every((l) => placed.has(l.predecessor_id)));
    ready.sort((a, b) => {
      const ca = cpm.get(a.id)!, cb = cpm.get(b.id)!;
      // Minimum float first: critical work claims resources, flexible work fills the gaps.
      return ca.total_float - cb.total_float || ca.early_start.localeCompare(cb.early_start) || a.id.localeCompare(b.id);
    });
    const it = ready[0]!;
    const d = dur.get(it.id)!;
    let s = Math.max(W.idx(it.start_date), ...(preds.get(it.id) ?? []).map((l) => {
      const ps = placed.get(l.predecessor_id)!;
      const pf = ps + dur.get(l.predecessor_id)!;
      switch (l.link_type ?? "FS") {
        case "SS": return ps + l.lag_days;
        case "FF": return pf + l.lag_days - d;
        case "SF": return ps + l.lag_days - d;
        default: return pf + 1 + l.lag_days;
      }
    }));
    const as = needs(it);
    if (as.length && it.splittable && d > 0) {
      // Splittable: take the earliest d+1 working days where every resource has capacity, not necessarily consecutive.
      const days: number[] = [];
      for (let t = s, guard = 0; days.length < d + 1; t++) {
        if (fits(as, t, 0)) days.push(t);
        if (++guard > 20000) throw new Error("Could not level within the scheduling window");
      }
      for (const t of days) book(as, t, 0);
      const segments: [string, string][] = [];
      for (let i = 0; i < days.length; i++) {
        if (i === 0 || days[i]! !== days[i - 1]! + 1) segments.push([W.date(days[i]!), W.date(days[i]!)]);
        else segments[segments.length - 1]![1] = W.date(days[i]!);
      }
      // Successors see the true finish (last work day), so record it as the span the activity occupies.
      placed.set(it.id, days[0]!);
      dur.set(it.id, days.at(-1)! - days[0]!);
      result.set(it.id, { start_date: W.date(days[0]!), end_date: W.date(days.at(-1)!), delay_days: days[0]! - W.idx(cpm.get(it.id)!.early_start), segments });
      continue;
    }
    if (as.length) {
      let guard = 0;
      while (!fits(as, s, d)) {
        s++;
        if (++guard > 20000) throw new Error("Could not level within the scheduling window");
      }
      book(as, s, d);
    }
    placed.set(it.id, s);
    result.set(it.id, { start_date: W.date(s), end_date: W.date(s + d), delay_days: s - W.idx(cpm.get(it.id)!.early_start) });
  }
  const finishBefore = [...cpm.values()].map((c) => c.early_finish).sort().at(-1)!;
  const finishAfter = [...result.values()].map((r) => r.end_date).sort().at(-1)!;
  return { result, finishBefore, finishAfter };
}

/** Working days covered by [start, end] segments under a calendar. */
export function workingDaysIn(segments: [string, string][], calendar?: WorkCalendar): number {
  if (!segments.length) return 0;
  const lo = Math.min(...segments.map(([a]) => calDay(a))) - 1;
  const hi = Math.max(...segments.map(([, b]) => calDay(b))) + 1;
  const W = workIndex(calendar, lo, hi);
  return segments.reduce((n, [a, b]) => n + W.span(a, b) + 1, 0);
}
