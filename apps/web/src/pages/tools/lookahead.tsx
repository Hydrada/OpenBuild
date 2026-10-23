import { useState } from "react";
import { api, fmtDate, label } from "../../api";
import { canWrite, useMemberOptions } from "../../components/records";
import { Badge, Creator, ErrorText, Form, Loading } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

const thisMonday = () => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toLocaleDateString("en-CA");
};
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

/** Three-week (configurable) lookahead: master activities in the window with short-interval tasks under them. */
export function LookaheadTool({ project }: { project: ProjectInfo }) {
  const [from, setFrom] = useState(thisMonday());
  const [weeks, setWeeks] = useState(3);
  const la = useApi(`/projects/${project.id}/lookahead?from=${from}&weeks=${weeks}`);
  const { options } = useMemberOptions(project.id);
  const { error, run } = useAction();
  const [blocking, setBlocking] = useState<{ id: string; why: string } | null>(null);
  const d = la.data;
  const writer = canWrite(project.myRole);
  const setStatus = (id: string, body: object) => run(async () => { await api("PATCH", `/lookahead-tasks/${id}`, body); la.reload(); });

  const bar = (start: string, end: string, cls: string, name: string) => d.days.map((day: any) => (
    <td key={day.date} className={`la-cell ${day.working ? "" : "off"} ${day.date >= start && day.date <= end ? cls : ""}`} aria-label={day.date >= start && day.date <= end ? `${name} on ${day.date}` : undefined} />
  ));

  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Lookahead</h2>
        <button type="button" onClick={() => setFrom(shift(from, -7))}>◀ Week</button>
        <label className="inline">Starting <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <button type="button" onClick={() => setFrom(shift(from, 7))}>Week ▶</button>
        <label className="inline">Weeks <select aria-label="Weeks shown" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[2, 3, 4, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <button type="button" onClick={() => print()}>Print</button>
        {writer && d && (
          <Creator label="Add lookahead task">
            {(close) => (
              <Form ariaLabel="Add lookahead task" submitLabel="Add task" onCancel={close} initial={{ startDate: d.from, endDate: d.from }}
                fields={[
                  { name: "name", label: "Task", required: true, full: true },
                  { name: "scheduleItemId", label: "Under activity", type: "select", options: d.activities.map((a: any) => ({ value: a.id, label: a.name })) },
                  { name: "startDate", label: "Start", type: "date", required: true },
                  { name: "endDate", label: "Finish", type: "date", required: true },
                  { name: "company", label: "Company" },
                  { name: "crewSize", label: "Crew size", type: "number", min: "0", step: "1" },
                  { name: "assigneeId", label: "Foreman / responsible", type: "select", options },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/lookahead-tasks`, {
                    name: v.name, scheduleItemId: v.scheduleItemId || null, startDate: v.startDate, endDate: v.endDate, company: v.company || null,
                    crewSize: v.crewSize === "" || v.crewSize == null ? null : Number(v.crewSize), assigneeId: v.assigneeId || null,
                  });
                  close(); la.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <ErrorText error={la.error ?? error} />
      {!d ? <Loading /> : (
        <section className="card lookahead" aria-label="Lookahead grid">
          <p className="muted small">{fmtDate(d.from)} – {fmtDate(d.to)} · shaded columns are non-working days · red bars are on the critical path</p>
          <div className="table-wrap">
            <table className="table la-grid">
              <caption className="sr-only">Lookahead {d.from} to {d.to}</caption>
              <thead>
                <tr>
                  <th scope="col">Activity / task</th><th scope="col">Who</th><th scope="col">Status</th>
                  {d.days.map((day: any) => <th key={day.date} scope="col" className={`la-day ${day.working ? "" : "off"}`} title={day.date}>{DOW[new Date(`${day.date}T00:00:00Z`).getUTCDay()]}<br />{day.date.slice(8)}</th>)}
                </tr>
              </thead>
              <tbody>
                {[...d.activities, { id: null, name: "Not under an activity" }].map((a: any) => {
                  const tasks = d.tasks.filter((t: any) => (t.schedule_item_id ?? null) === a.id);
                  if (!a.id && !tasks.length) return null;
                  return [
                    <tr key={a.id ?? "none"} className="la-activity">
                      <th scope="row">{a.name}{a.id && a.total_float !== null && <span className="muted small"> · float {a.total_float} d</span>}</th>
                      <td>{a.assignee_name ?? ""}</td><td>{a.id ? `${a.percent_complete}%` : ""}</td>
                      {a.id ? bar(a.start_date, a.end_date, a.critical ? "bar critical" : "bar", a.name) : d.days.map((day: any) => <td key={day.date} className={`la-cell ${day.working ? "" : "off"}`} />)}
                    </tr>,
                    ...tasks.map((t: any) => (
                      <tr key={t.id} className="la-task">
                        <td>↳ {t.name}{t.status === "blocked" && <div className="small danger">Blocked: {t.constraint_note}</div>}
                          {blocking?.id === t.id && (
                            <form className="row" onSubmit={(e) => { e.preventDefault(); setStatus(t.id, { status: "blocked", constraintNote: blocking!.why }); setBlocking(null); }}>
                              <input required aria-label={`What is blocking ${t.name}`} placeholder="What is blocking it?" value={blocking!.why} onChange={(e) => setBlocking({ id: t.id, why: e.target.value })} />
                              <button type="submit">Save</button> <button type="button" className="link" onClick={() => setBlocking(null)}>Cancel</button>
                            </form>
                          )}</td>
                        <td>{[t.company, t.assignee_name, t.crew_size != null ? `${t.crew_size} crew` : null].filter(Boolean).join(" · ")}</td>
                        <td>{writer
                          ? <select aria-label={`Status of ${t.name}`} value={t.status} onChange={(e) => {
                              const status = e.target.value;
                              if (status === "blocked") setBlocking({ id: t.id, why: t.constraint_note ?? "" });
                              else setStatus(t.id, { status });
                            }}>
                              {["planned", "in_progress", "done", "blocked"].map((s) => <option key={s} value={s}>{label(s)}</option>)}
                            </select>
                          : <Badge value={t.status} />}</td>
                        {bar(t.start_date, t.end_date, `bar task ${t.status}`, t.name)}
                      </tr>
                    )),
                  ];
                })}
              </tbody>
            </table>
          </div>
          {!d.activities.length && !d.tasks.length && <p className="muted">Nothing scheduled in this window.</p>}
        </section>
      )}
    </>
  );
}
