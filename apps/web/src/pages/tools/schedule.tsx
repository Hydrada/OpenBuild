import { useState } from "react";
import { api, fmtDate } from "../../api";
import { canWrite, useMemberOptions } from "../../components/records";
import { ActionButton, Creator, Empty, ErrorText, Form, Loading } from "../../components/ui";
import { useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

interface Item {
  id: string; name: string; start_date: string; end_date: string; is_milestone: boolean; percent_complete: number;
  predecessor_id: string | null; predecessor_name: string | null; assignee_id: string | null; assignee_name: string | null;
  late: boolean; dependency_conflict: boolean;
}

const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;

export function ScheduleTool({ project }: { project: ProjectInfo }) {
  const list = useApi<Item[]>(`/projects/${project.id}/schedule`);
  const writable = canWrite(project.myRole);
  const { options } = useMemberOptions(project.id);
  const [editing, setEditing] = useState<string | null>(null);
  const items = list.data;
  const predOptions = (items ?? []).map((i) => ({ value: i.id, label: i.name }));

  const fields = (excludeId?: string) => [
    { name: "name", label: "Activity", required: true, full: true },
    { name: "startDate", label: "Start", type: "date" as const, required: true },
    { name: "endDate", label: "Finish (blank for milestone)", type: "date" as const },
    { name: "percentComplete", label: "% complete", type: "number" as const, min: "0", max: "100", step: "1" },
    { name: "predecessorId", label: "Depends on", type: "select" as const, options: predOptions.filter((o) => o.value !== excludeId) },
    { name: "assigneeId", label: "Responsible", type: "select" as const, options },
    { name: "isMilestone", label: "Milestone", type: "checkbox" as const },
  ];
  const body = (v: Record<string, any>) => ({
    name: v.name, startDate: v.startDate, endDate: v.endDate || undefined, isMilestone: !!v.isMilestone,
    percentComplete: v.percentComplete === "" ? 0 : Number(v.percentComplete), predecessorId: v.predecessorId || null, assigneeId: v.assigneeId || null,
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
                <span className={`gantt-bar ${i.late ? "late" : ""} ${i.dependency_conflict ? "conflict" : ""}`}
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
        {writable && (
          <Creator label="Add activity">
            {(close) => (
              <Form ariaLabel="New schedule activity" submitLabel="Add to schedule" onCancel={close} fields={fields()}
                onSubmit={async (v) => { await api("POST", `/projects/${project.id}/schedule`, body(v)); close(); list.reload(); }} />
            )}
          </Creator>
        )}
      </div>
      <ErrorText error={list.error} />
      {!items ? <Loading /> : items.length === 0 ? <Empty>No schedule yet. Add activities and milestones.</Empty> : (
        <>
          <section className="card">{chart}</section>
          <section className="card">
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Schedule activities</caption>
                <thead><tr><th>Activity</th><th>Start</th><th>Finish</th><th>%</th><th>Depends on</th><th>Responsible</th><th>Flags</th>{writable && <th />}</tr></thead>
                <tbody>
                  {items.map((i) => editing === i.id ? (
                    <tr key={i.id}><td colSpan={writable ? 8 : 7}>
                      <Form ariaLabel={`Edit ${i.name}`} submitLabel="Save" className="flat" onCancel={() => setEditing(null)} fields={fields(i.id)}
                        initial={{ name: i.name, startDate: i.start_date, endDate: i.is_milestone ? "" : i.end_date, percentComplete: String(i.percent_complete), predecessorId: i.predecessor_id ?? "", assigneeId: i.assignee_id ?? "", isMilestone: i.is_milestone }}
                        onSubmit={async (v) => { await api("PATCH", `/schedule/${i.id}`, body(v)); setEditing(null); list.reload(); }} />
                    </td></tr>
                  ) : (
                    <tr key={i.id}>
                      <td>{i.is_milestone ? "◆ " : ""}{i.name}</td>
                      <td>{fmtDate(i.start_date)}</td>
                      <td>{i.is_milestone ? "—" : fmtDate(i.end_date)}</td>
                      <td>{i.percent_complete}</td>
                      <td>{i.predecessor_name ?? "—"}</td>
                      <td>{i.assignee_name ?? "—"}</td>
                      <td>
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
