import { useState } from "react";
import { api, fmtDate } from "../../api";
import { canManage, canWrite, useMemberOptions } from "../../components/records";
import { ActionButton, Creator, Empty, ErrorText, Form, Loading } from "../../components/ui";
import { useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

interface Item {
  id: string; name: string; start_date: string; end_date: string; is_milestone: boolean; percent_complete: number;
  predecessor_id: string | null; predecessor_name: string | null; predecessors: { id: string; name: string; lagDays: number; type: string }[]; assignee_id: string | null; assignee_name: string | null;
  late: boolean; dependency_conflict: boolean; early_start: string; early_finish: string; total_float: number; critical: boolean;
}

const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;

export function ScheduleTool({ project }: { project: ProjectInfo }) {
  const list = useApi<Item[]>(`/projects/${project.id}/schedule`);
  const writable = canWrite(project.myRole);
  const { options } = useMemberOptions(project.id);
  const [editing, setEditing] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const items = list.data;
  const predOptions = (items ?? []).map((i) => ({ value: i.id, label: i.name }));

  const fields = (excludeId?: string) => [
    { name: "name", label: "Activity", required: true, full: true },
    { name: "startDate", label: "Start", type: "date" as const, required: true },
    { name: "endDate", label: "Finish (blank for milestone)", type: "date" as const },
    { name: "percentComplete", label: "% complete", type: "number" as const, min: "0", max: "100", step: "1" },
    { name: "predecessorIds", label: "Depends on (finish-to-start; Ctrl/Cmd-click for several)", type: "multiselect" as const, options: predOptions.filter((o) => o.value !== excludeId) },
    { name: "linkType", label: "Link type", type: "select" as const, required: true, options: [
      { value: "FS", label: "Finish → start (FS)" }, { value: "SS", label: "Start → start (SS)" },
      { value: "FF", label: "Finish → finish (FF)" }, { value: "SF", label: "Start → finish (SF)" }] },
    { name: "lagDays", label: "Lag (days)", type: "number" as const, step: "1" },
    { name: "assigneeId", label: "Responsible", type: "select" as const, options },
    { name: "isMilestone", label: "Milestone", type: "checkbox" as const },
  ];
  const body = (v: Record<string, any>) => ({
    name: v.name, startDate: v.startDate, endDate: v.endDate || undefined, isMilestone: !!v.isMilestone,
    percentComplete: v.percentComplete === "" ? 0 : Number(v.percentComplete), predecessors: (v.predecessorIds as string[]).map((id) => ({ id, type: v.linkType || "FS", lagDays: Number(v.lagDays) || 0 })), assigneeId: v.assigneeId || null,
  });

  let chart = null;
  if (items?.length) {
    const min = Math.min(...items.map((i) => day(i.start_date)));
    const max = Math.max(...items.map((i) => day(i.end_date))) + 1;
    const span = Math.max(1, max - min);
    const pct = (d: number) => `${((d - min) / span) * 100}%`;
    const todayPos = (Date.now() / 86_400_000 - min) / span;
    chart = (
      <div className="gantt" role="img" aria-label={`Schedule bar chart from ${fmtDate(items[0]!.start_date)}`}>
        {items.map((i) => (
          <div key={i.id} className="gantt-row">
            <div className="gantt-label">{i.name}</div>
            <div className="gantt-track">
              {todayPos >= 0 && todayPos <= 1 && <span className="gantt-today" style={{ left: `${todayPos * 100}%` }} aria-hidden="true" />}
              {i.is_milestone ? (
                <span className={`gantt-milestone ${i.late ? "late" : ""}`} style={{ left: pct(day(i.start_date)) }} title={`${i.name}: ${fmtDate(i.start_date)}`} />
              ) : (
                <span className={`gantt-bar ${i.critical ? "critical" : ""} ${i.late ? "late" : ""} ${i.dependency_conflict ? "conflict" : ""}`}
                  style={{ left: pct(day(i.start_date)), width: `calc(${((day(i.end_date) + 1 - day(i.start_date)) / span) * 100}% - 2px)` }}
                  title={`${i.name}: ${fmtDate(i.start_date)} – ${fmtDate(i.end_date)}, ${i.percent_complete}%`}>
                  <span className="gantt-done" style={{ width: `${i.percent_complete}%` }} />
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Schedule</h2>
        {canManage(project.myRole) && (
          <Creator label="Import MS Project XML">
            {(close) => (
              <Form ariaLabel="Import schedule" submitLabel="Import" onCancel={close}
                fields={[{ name: "file", label: "Microsoft Project XML (also from P6, ProjectLibre, GanttProject)", type: "file", accept: ".xml,text/xml", required: true }]}
                onSubmit={async (v) => { const r = await api("POST", `/projects/${project.id}/schedule/import`, { xml: await (v.file as File).text() }); setImported(`Imported: ${r.created} new, ${r.updated} updated, ${r.links} links`); close(); list.reload(); }} />
            )}
          </Creator>
        )}
        {canManage(project.myRole) && (
          <Creator label="Working calendar">
            {(close) => <CalendarForm projectId={project.id} onDone={() => { close(); list.reload(); }} onCancel={close} />}
          </Creator>
        )}
        {writable && (
          <Creator label="Add activity">
            {(close) => (
              <Form ariaLabel="New schedule activity" submitLabel="Add to schedule" onCancel={close} fields={fields()} initial={{ linkType: "FS" }}
                onSubmit={async (v) => { await api("POST", `/projects/${project.id}/schedule`, body(v)); close(); list.reload(); }} />
            )}
          </Creator>
        )}
      </div>
      <ErrorText error={list.error} />
      {imported && <p className="notice" role="status">{imported}</p>}
      {!items ? <Loading /> : items.length === 0 ? <Empty>No schedule yet. Add activities and milestones.</Empty> : (
        <>
          <section className="card">{chart}</section>
          <section className="card">
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Schedule activities</caption>
                <thead><tr><th>Activity</th><th>Start</th><th>Finish</th><th>%</th><th>Early start</th><th>Float (working days)</th><th>Depends on</th><th>Responsible</th><th>Flags</th>{writable && <th />}</tr></thead>
                <tbody>
                  {items.map((i) => editing === i.id ? (
                    <tr key={i.id}><td colSpan={writable ? 10 : 9}>
                      <Form ariaLabel={`Edit ${i.name}`} submitLabel="Save" className="flat" onCancel={() => setEditing(null)} fields={fields(i.id)}
                        initial={{ name: i.name, startDate: i.start_date, endDate: i.is_milestone ? "" : i.end_date, percentComplete: String(i.percent_complete), predecessorIds: i.predecessors.map((p) => p.id), linkType: i.predecessors[0]?.type ?? "FS", lagDays: String(i.predecessors[0]?.lagDays ?? 0), assigneeId: i.assignee_id ?? "", isMilestone: i.is_milestone }}
                        onSubmit={async (v) => { await api("PATCH", `/schedule/${i.id}`, body(v)); setEditing(null); list.reload(); }} />
                    </td></tr>
                  ) : (
                    <tr key={i.id}>
                      <td>{i.is_milestone ? "◆ " : ""}{i.name}</td>
                      <td>{fmtDate(i.start_date)}</td>
                      <td>{i.is_milestone ? "—" : fmtDate(i.end_date)}</td>
                      <td>{i.percent_complete}</td>
                      <td>{fmtDate(i.early_start)}</td>
                      <td>{i.total_float}</td>
                      <td>{i.predecessors.length ? i.predecessors.map((p) => `${p.name} (${p.type}${p.lagDays ? ` ${p.lagDays > 0 ? "+" : ""}${p.lagDays}d` : ""})`).join(", ") : "—"}</td>
                      <td>{i.assignee_name ?? "—"}</td>
                      <td>
                        {i.critical && <span className="badge badge-high" title="Zero float: any delay moves the project finish">Critical</span>}{" "}
                        {i.late && <span className="badge badge-rejected">Late</span>}{" "}
                        {i.dependency_conflict && <span className="badge badge-pending" title="Starts before its predecessor finishes">Dependency conflict</span>}
                      </td>
                      {writable && (
                        <td className="row-actions">
                          <button className="link" onClick={() => setEditing(i.id)}>Edit</button>
                          <ActionButton className="link danger" confirm={`Delete "${i.name}"?`} onClick={async () => { await api("DELETE", `/schedule/${i.id}`); list.reload(); }}>Delete</ActionButton>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NL = String.fromCharCode(10);

function CalendarForm({ projectId, onDone, onCancel }: { projectId: string; onDone: () => void; onCancel: () => void }) {
  const cal = useApi<{ workDays: number[]; holidays: { day: string; name: string }[] }>(`/projects/${projectId}/calendar`);
  if (!cal.data) return <Loading />;
  return (
    <Form ariaLabel="Working calendar" submitLabel="Save calendar" onCancel={onCancel}
      initial={{ ...Object.fromEntries(WEEKDAYS.map((_, i) => [`d${i}`, cal.data!.workDays.includes(i)])), holidays: cal.data.holidays.map((h) => `${h.day} ${h.name}`).join(NL) }}
      fields={[
        ...WEEKDAYS.map((d, i) => ({ name: `d${i}`, label: `${d} is a working day`, type: "checkbox" as const })),
        { name: "holidays", label: "Non-working days, one per line: YYYY-MM-DD Name", type: "textarea" as const },
      ]}
      onSubmit={async (v) => {
        const holidays = String(v.holidays).split(NL).map((l) => l.trim()).filter(Boolean).map((l) => {
          const m = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(l);
          if (!m) throw new Error(`Could not read "${l}" — use YYYY-MM-DD Name`);
          return { day: m[1], name: m[2] };
        });
        await api("PUT", `/projects/${projectId}/calendar`, { workDays: WEEKDAYS.map((_, i) => i).filter((i) => v[`d${i}`]), holidays });
        onDone();
      }} />
  );
}
