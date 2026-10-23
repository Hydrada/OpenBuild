import { useState } from "react";
import { api, fmtBytes, fmtDate, fmtDateTime, label, today } from "../../api";
import { Attachments, Comments, CustomFields, canManage, canWrite, useMemberOptions } from "../../components/records";
import { ActionButton, Badge, Creator, DataTable, Empty, ErrorText, Form, KeyValues, Link, Loading, PageHead } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import { createOrQueue, updateOrQueue } from "../../offline";
import type { ProjectInfo } from "../Project";

function Queued({ show }: { show: boolean }) {
  return show ? <p className="notice" role="status">You are offline — saved on this device and will sync automatically when you reconnect.</p> : null;
}

// ---------------- Daily log ----------------

export function DailyLogsTool({ project }: { project: ProjectInfo }) {
  const logs = useApi<any[]>(`/projects/${project.id}/daily-logs`);
  const [queued, setQueued] = useState(false);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Daily log</h2>
        {canWrite(project.myRole) && (
          <Creator label="New daily log">
            {(close) => (
              <Form ariaLabel="New daily log" submitLabel="Create log" onCancel={close} initial={{ logDate: today() }}
                fields={[
                  { name: "logDate", label: "Date", type: "date", required: true },
                  { name: "weather", label: "Weather", placeholder: "Clear, light wind" },
                  { name: "tempLow", label: "Low °F", type: "number", step: "0.1" },
                  { name: "tempHigh", label: "High °F", type: "number", step: "0.1" },
                  { name: "workPerformed", label: "Work performed", type: "textarea" },
                  { name: "delays", label: "Delays", type: "textarea" },
                  { name: "visitors", label: "Visitors / inspections", type: "textarea" },
                  { name: "notes", label: "Notes", type: "textarea" },
                ]}
                onSubmit={async (v) => {
                  const r = await createOrQueue(`/projects/${project.id}/daily-logs`, {
                    logDate: v.logDate, weather: v.weather || null, tempLow: v.tempLow === "" ? null : Number(v.tempLow), tempHigh: v.tempHigh === "" ? null : Number(v.tempHigh),
                    workPerformed: v.workPerformed || null, delays: v.delays || null, visitors: v.visitors || null, notes: v.notes || null,
                  }, `Daily log ${v.logDate}`);
                  setQueued(r.queued); close(); logs.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <Queued show={queued} />
      <section className="card">
        <ErrorText error={logs.error} />
        <DataTable rows={logs.data} href={(l) => `/daily-logs/${l.id}`} empty="No daily logs yet." caption="Daily logs" columns={[
          { label: "Date", render: (l) => fmtDate(l.log_date) },
          { label: "Weather", render: (l) => l.weather ?? "—" },
          { label: "Temp", render: (l) => l.temp_low || l.temp_high ? `${l.temp_low ?? "?"}–${l.temp_high ?? "?"} °F` : "—" },
          { label: "Workers", render: (l) => l.workers },
          { label: "Hours", render: (l) => l.hours },
          { label: "Status", render: (l) => <Badge value={l.status} /> },
          { label: "By", render: (l) => l.created_by_name ?? "—" },
        ]} />
      </section>
    </>
  );
}

export function DailyLogPage({ id }: { id: string }) {
  const r = useApi(`/daily-logs/${id}`);
  const [rows, setRows] = useState<any[] | null>(null);
  const [logQueued, setLogQueued] = useState(false);
  const { busy, error, run } = useAction();
  const log = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!log) return <Loading />;
  const editable = canWrite(log.myRole) && log.status !== "signed";
  const manpower = rows ?? log.manpower.map((m: any) => ({ ...m }));
  const setRow = (i: number, k: string, v: string) => setRows(manpower.map((m: any, j: number) => (j === i ? { ...m, [k]: v } : m)));
  const totalWorkers = manpower.reduce((n: number, m: any) => n + (Number(m.workers) || 0), 0);
  return (
    <>
      <PageHead pdf={`/daily-logs/${log.id}/pdf`} back={{ to: `/projects/${log.project_id}/daily-log`, label: "Daily log" }} title={<>Daily log — {fmtDate(log.log_date)} <Badge value={log.status} /></>}
        sub={log.status === "signed" ? `Signed by ${log.signed_by_name} ${fmtDateTime(log.signed_at)}` : `Created by ${log.created_by_name ?? "—"}`}
        actions={canManage(log.myRole) && log.status !== "signed" && <ActionButton className="primary" confirm="Signing locks this log. Continue?" onClick={async () => { await api("POST", `/daily-logs/${log.id}/sign`); r.reload(); }}>Sign log</ActionButton>} />
      <Queued show={logQueued} />
      {editable ? (
        <Form ariaLabel="Daily log details" submitLabel="Save log" initial={{ weather: log.weather ?? "", workPerformed: log.work_performed ?? "", delays: log.delays ?? "", visitors: log.visitors ?? "", notes: log.notes ?? "" }}
          fields={[
            { name: "weather", label: "Weather" },
            { name: "workPerformed", label: "Work performed", type: "textarea" },
            { name: "delays", label: "Delays", type: "textarea" },
            { name: "visitors", label: "Visitors / inspections", type: "textarea" },
            { name: "notes", label: "Notes", type: "textarea" },
          ]}
          onSubmit={async (v) => {
            const q = await updateOrQueue("PATCH", `/daily-logs/${log.id}`, { weather: v.weather || null, workPerformed: v.workPerformed || null, delays: v.delays || null, visitors: v.visitors || null, notes: v.notes || null }, `Daily log ${log.log_date}: edits`);
            setLogQueued(q.queued); r.reload();
          }} />
      ) : (
        <section className="card">
          <KeyValues items={[["Weather", log.weather], ["Temperature", `${log.temp_low ?? "?"}–${log.temp_high ?? "?"} °F`], ["Work performed", log.work_performed], ["Delays", log.delays], ["Visitors", log.visitors], ["Notes", log.notes]]} />
        </section>
      )}
      <section className="card" aria-label="Manpower">
        <h2>Manpower <span className="muted small">{totalWorkers} workers</span></h2>
        {manpower.length === 0 && !editable && <Empty>No manpower recorded.</Empty>}
        {(manpower.length > 0 || editable) && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Company</th><th>Trade</th><th>Workers</th><th>Hours</th><th>Notes</th>{editable && <th />}</tr></thead>
              <tbody>
                {manpower.map((m: any, i: number) => (
                  <tr key={i}>
                    {editable ? <>
                      <td><input aria-label={`Company row ${i + 1}`} value={m.company} onChange={(e) => setRow(i, "company", e.target.value)} /></td>
                      <td><input aria-label={`Trade row ${i + 1}`} value={m.trade ?? ""} onChange={(e) => setRow(i, "trade", e.target.value)} /></td>
                      <td><input aria-label={`Workers row ${i + 1}`} type="number" min="0" value={m.workers} onChange={(e) => setRow(i, "workers", e.target.value)} /></td>
                      <td><input aria-label={`Hours row ${i + 1}`} inputMode="decimal" value={m.hours} onChange={(e) => setRow(i, "hours", e.target.value)} /></td>
                      <td><input aria-label={`Notes row ${i + 1}`} value={m.notes ?? ""} onChange={(e) => setRow(i, "notes", e.target.value)} /></td>
                      <td><button className="link danger" onClick={() => setRows(manpower.filter((_: any, j: number) => j !== i))}>Remove</button></td>
                    </> : <><td>{m.company}</td><td>{m.trade ?? "—"}</td><td>{m.workers}</td><td>{m.hours}</td><td>{m.notes ?? ""}</td></>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && (
          <div className="actions">
            <button onClick={() => setRows([...manpower, { company: "", trade: "", workers: "0", hours: "0", notes: "" }])}>Add company</button>
            <button className="primary" disabled={busy || rows === null} onClick={() => run(async () => {
              await api("PATCH", `/daily-logs/${log.id}`, { manpower: manpower.filter((m: any) => m.company).map((m: any) => ({ company: m.company, trade: m.trade || null, workers: Number(m.workers) || 0, hours: String(m.hours || "0"), notes: m.notes || null })) });
              setRows(null); r.reload();
            })}>Save manpower</button>
          </div>
        )}
        <ErrorText error={error} />
      </section>
      <Attachments title="Photos" accept="image/*" entityType="daily_log" entityId={log.id} projectId={log.project_id} files={log.photos} onChange={r.reload} canAdd={editable} />
      <Comments entityType="daily_log" entityId={log.id} projectId={log.project_id} />
    </>
  );
}

// ---------------- Inspections ----------------

export function InspectionsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/inspections`);
  const templates = useApi<any[]>(`/orgs/${project.org_id}/inspection-templates`);
  const { options } = useMemberOptions(project.id);
  const [queued, setQueued] = useState(false);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Inspections</h2>
        {canWrite(project.myRole) && (
          <Creator label="New inspection">
            {(close) => (
              <Form ariaLabel="New inspection" submitLabel="Start inspection" onCancel={close}
                fields={[
                  { name: "title", label: "Title", required: true, placeholder: "Level 2 pre-pour" },
                  { name: "location", label: "Location" },
                  { name: "templateId", label: "Checklist template", type: "select", options: (templates.data ?? []).map((t) => ({ value: t.id, label: `${t.name} (${t.items.length} items)` })) },
                  { name: "inspectorId", label: "Inspector", type: "select", options },
                  { name: "items", label: "Extra checklist items (one per line)", type: "textarea" },
                ]}
                onSubmit={async (v) => {
                  const items = String(v.items).split("\n").map((s) => s.trim()).filter(Boolean);
                  const r = await createOrQueue(`/projects/${project.id}/inspections`, { title: v.title, location: v.location || null, templateId: v.templateId || null, inspectorId: v.inspectorId || null, items }, v.title);
                  setQueued(r.queued); close(); list.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <Queued show={queued} />
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(i) => `/inspections/${i.id}`} empty="No inspections yet." caption="Inspections" columns={[
          { label: "Title", render: (i) => i.title },
          { label: "Location", render: (i) => i.location ?? "—" },
          { label: "Inspector", render: (i) => i.inspector_name ?? "—" },
          { label: "Progress", render: (i) => `${i.total - i.unanswered}/${i.total}` },
          { label: "Failed", render: (i) => i.failed ? <span className="overdue">{i.failed}</span> : 0 },
          { label: "Status", render: (i) => <Badge value={i.status} /> },
        ]} />
      </section>
    </>
  );
}

export function InspectionPage({ id }: { id: string }) {
  const r = useApi(`/inspections/${id}`);
  const ins = r.data;
  const { options } = useMemberOptions(ins?.project_id);
  const { error, run } = useAction();
  const [punchFor, setPunchFor] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  if (r.error) return <ErrorText error={r.error} />;
  if (!ins) return <Loading />;
  const editable = canWrite(ins.myRole) && ins.status !== "completed";
  const setItem = (itemId: string, body: Record<string, unknown>) =>
    run(async () => { const q = await updateOrQueue("PATCH", `/inspections/${ins.id}/items/${itemId}`, body, `${ins.title}: item result`); if (q.queued) setQueued(true); }).then(r.reload);
  return (
    <>
      <PageHead back={{ to: `/projects/${ins.project_id}/inspections`, label: "Inspections" }} title={<>{ins.title} <Badge value={ins.status} /></>}
        sub={`${ins.location ?? "No location"} · inspector ${ins.inspector_name ?? "—"}${ins.completed_at ? ` · completed ${fmtDateTime(ins.completed_at)}` : ""}`}
        actions={editable && <ActionButton className="primary" onClick={async () => { await api("POST", `/inspections/${ins.id}/complete`); r.reload(); }}>Complete inspection</ActionButton>} />
      <ErrorText error={error} />
      <Queued show={queued} />
      <section className="card" aria-label="Checklist">
        <ol className="checklist">
          {ins.items.map((it: any) => (
            <li key={it.id} className={it.result ? `result-${it.result}` : ""}>
              <div className="check-text">{it.text}</div>
              <div className="check-controls" role="group" aria-label={`Result for ${it.text}`}>
                {(["pass", "fail", "na"] as const).map((res) => (
                  <button key={res} disabled={!editable} aria-pressed={it.result === res} className={`seg ${it.result === res ? `on-${res}` : ""}`} onClick={() => setItem(it.id, { result: res })}>{label(res)}</button>
                ))}
              </div>
              {it.note && <div className="muted small">Note: {it.note}</div>}
              {it.punch_item_id ? (
                <div className="small"><Link to={`/punch/${it.punch_item_id}`}>Punch item #{it.punch_number}</Link> <Badge value={it.punch_status} /></div>
              ) : it.result === "fail" && editable && (
                punchFor === it.id ? (
                  <Form ariaLabel="Create punch item" submitLabel="Create punch item" className="flat" onCancel={() => setPunchFor(null)}
                    fields={[{ name: "note", label: "Deficiency note" }, { name: "assigneeId", label: "Assign to", type: "select", options }, { name: "dueDate", label: "Due", type: "date" }]}
                    onSubmit={async (v) => { await api("PATCH", `/inspections/${ins.id}/items/${it.id}`, { note: v.note || undefined, createPunch: { assigneeId: v.assigneeId || null, dueDate: v.dueDate || null } }); setPunchFor(null); r.reload(); }} />
                ) : <button className="link" onClick={() => setPunchFor(it.id)}>Create punch item</button>
              )}
            </li>
          ))}
        </ol>
      </section>
      <Attachments title="Photos" accept="image/*" entityType="inspection" entityId={ins.id} projectId={ins.project_id} files={ins.photos} onChange={r.reload} canAdd={canWrite(ins.myRole)} />
      <Comments entityType="inspection" entityId={ins.id} projectId={ins.project_id} />
    </>
  );
}

// ---------------- Punch list ----------------

export function PunchTool({ project }: { project: ProjectInfo }) {
  const [filter, setFilter] = useState({ status: "", mine: false });
  const list = useApi<any[]>(`/projects/${project.id}/punch-items?${new URLSearchParams({ ...(filter.status ? { status: filter.status } : {}), ...(filter.mine ? { mine: "1" } : {}) })}`);
  const writable = canWrite(project.myRole);
  const { options } = useMemberOptions(writable ? project.id : null);
  const [queued, setQueued] = useState(false);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Punch list</h2>
        <div className="actions">
          <a className="button" href={`/api/projects/${project.id}/punch-list.pdf`} download>Download PDF</a>
          {writable && (
            <Creator label="Import CSV">
              {(close) => (
                <Form ariaLabel="Import punch items" submitLabel="Import" onCancel={close}
                  fields={[{ name: "file", label: "CSV with columns Title, Location, Trade, Due (YYYY-MM-DD)", type: "file", accept: ".csv,text/csv", required: true }]}
                  onSubmit={async (v) => { await api("POST", `/projects/${project.id}/import/punch-items`, { csv: await (v.file as File).text() }); close(); list.reload(); }} />
              )}
            </Creator>
          )}
          {writable && (
            <Creator label="New punch item">
              {(close) => (
                <Form ariaLabel="New punch item" submitLabel="Create item" onCancel={close}
                  fields={[
                    { name: "title", label: "Title", required: true, full: true },
                    { name: "location", label: "Location" },
                    { name: "trade", label: "Trade" },
                    { name: "assigneeId", label: "Assignee", type: "select", options },
                    { name: "dueDate", label: "Due", type: "date" },
                    { name: "description", label: "Description", type: "textarea" },
                  ]}
                  onSubmit={async (v) => {
                    const r = await createOrQueue(`/projects/${project.id}/punch-items`, { title: v.title, location: v.location || null, trade: v.trade || null, assigneeId: v.assigneeId || null, dueDate: v.dueDate || null, description: v.description || null }, v.title);
                    setQueued(r.queued); close(); list.reload();
                  }} />
              )}
            </Creator>
          )}
        </div>
      </div>
      <Queued show={queued} />
      <div className="filters">
        <label>Status <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="">All</option>{["open", "ready_for_review", "closed"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label>
        {project.myRole !== "subcontractor" && <label className="check"><input type="checkbox" checked={filter.mine} onChange={(e) => setFilter({ ...filter, mine: e.target.checked })} /> Assigned to me</label>}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(p) => `/punch/${p.id}`} empty="No punch items." caption="Punch list" columns={[
          { label: "#", render: (p) => p.number },
          { label: "Title", render: (p) => p.title },
          { label: "Location", render: (p) => p.location ?? "—" },
          { label: "Assignee", render: (p) => p.assignee_name ?? "—" },
          { label: "Due", render: (p) => <span className={p.overdue ? "overdue" : ""}>{fmtDate(p.due_date)}</span> },
          { label: "Photos", render: (p) => p.photo_count },
          { label: "Status", render: (p) => <Badge value={p.status} /> },
        ]} />
      </section>
    </>
  );
}

export function PunchPage({ id }: { id: string }) {
  const r = useApi(`/punch-items/${id}`);
  const p = r.data;
  const [queued, setQueued] = useState(false);
  const { options } = useMemberOptions(p && canWrite(p.myRole) ? p.project_id : null);
  if (r.error) return <ErrorText error={r.error} />;
  if (!p) return <Loading />;
  const manager = canManage(p.myRole);
  const verifier = manager || (p.created_by === p.myId && canWrite(p.myRole));
  const isAssignee = p.assignee_id === p.myId;
  const status = (s: string, requirePhoto = false) => async () => {
    const q = await updateOrQueue("POST", `/punch-items/${p.id}/status`, { status: s, requirePhoto }, `Punch #${p.number}: ${s.replace(/_/g, " ")}`);
    if (q.queued) setQueued(true);
    r.reload();
  };
  return (
    <>
      <PageHead back={{ to: `/projects/${p.project_id}/punch`, label: "Punch list" }} title={<>Punch #{p.number}: {p.title} <Badge value={p.status} /></>}
        actions={<>
          {p.status === "open" && (isAssignee || verifier) && <ActionButton className="primary" onClick={status("ready_for_review")}>Mark ready for review</ActionButton>}
          {p.status !== "closed" && verifier && <ActionButton className="primary" onClick={status("closed", true)}>Verify & close</ActionButton>}
          {p.status !== "open" && verifier && <ActionButton onClick={status("open")}>{p.status === "closed" ? "Reopen" : "Send back"}</ActionButton>}
        </>} />
      <Queued show={queued} />
      <section className="card">
        <KeyValues items={[
          ["Location", p.location], ["Trade", p.trade], ["Assignee", p.assignee_name], ["Due", fmtDate(p.due_date)],
          ["Created by", p.created_by_name], ["From inspection", p.inspection ? <Link to={`/inspections/${p.inspection.id}`}>{p.inspection.title}</Link> : null],
          ["Description", p.description],
        ]} />
        <p className="muted small">Closing requires at least one photo as evidence.</p>
      </section>
      {canWrite(p.myRole) && p.status !== "closed" && (
        <Form ariaLabel="Edit punch item" submitLabel="Save" className="compact" initial={{ assigneeId: p.assignee_id ?? "", dueDate: p.due_date?.slice(0, 10) ?? "", location: p.location ?? "" }}
          fields={[{ name: "assigneeId", label: "Assignee", type: "select", options }, { name: "dueDate", label: "Due", type: "date" }, { name: "location", label: "Location" }]}
          onSubmit={async (v) => { await api("PATCH", `/punch-items/${p.id}`, { assigneeId: v.assigneeId || null, dueDate: v.dueDate || null, location: v.location || null }); r.reload(); }} />
      )}
      <Attachments title="Photos" accept="image/*" entityType="punch_item" entityId={p.id} projectId={p.project_id} files={p.photos} onChange={r.reload} canAdd={p.status !== "closed" && (canWrite(p.myRole) || isAssignee)} />
      <CustomFields entityType="punch_item" entityId={p.id} editable={canWrite(p.myRole)} />
      <Comments entityType="punch_item" entityId={p.id} projectId={p.project_id} />
    </>
  );
}

// ---------------- Observations ----------------

export function ObservationsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/observations`);
  const writable = canWrite(project.myRole);
  const { options } = useMemberOptions(writable ? project.id : null);
  const [queued, setQueued] = useState(false);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Observations</h2>
        {writable && (
          <Creator label="New observation">
            {(close) => (
              <Form ariaLabel="New observation" submitLabel="Record observation" onCancel={close} initial={{ type: "safety", severity: "medium" }}
                fields={[
                  { name: "title", label: "Title", required: true, full: true },
                  { name: "type", label: "Type", type: "select", required: true, options: ["safety", "quality", "environmental", "housekeeping"].map((v) => ({ value: v, label: label(v) })) },
                  { name: "severity", label: "Severity", type: "select", required: true, options: ["low", "medium", "high"].map((v) => ({ value: v, label: label(v) })) },
                  { name: "location", label: "Location" },
                  { name: "assigneeId", label: "Assign to", type: "select", options },
                  { name: "dueDate", label: "Correct by", type: "date" },
                  { name: "description", label: "Description", type: "textarea" },
                ]}
                onSubmit={async (v) => {
                  const r = await createOrQueue(`/projects/${project.id}/observations`, { ...v, location: v.location || null, assigneeId: v.assigneeId || null, dueDate: v.dueDate || null, description: v.description || null }, v.title);
                  setQueued(r.queued); close(); list.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <Queued show={queued} />
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(o) => `/observations/${o.id}`} empty="No observations." caption="Observations" columns={[
          { label: "Title", render: (o) => o.title },
          { label: "Type", render: (o) => label(o.type) },
          { label: "Severity", render: (o) => <Badge value={o.severity} /> },
          { label: "Location", render: (o) => o.location ?? "—" },
          { label: "Assignee", render: (o) => o.assignee_name ?? "—" },
          { label: "Status", render: (o) => <Badge value={o.status} /> },
        ]} />
      </section>
    </>
  );
}

export function ObservationPage({ id }: { id: string }) {
  const r = useApi(`/observations/${id}`);
  const o = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!o) return <Loading />;
  const canClose = o.status === "open" && (canWrite(o.myRole) || o.assignee_id === o.myId);
  return (
    <>
      <PageHead back={{ to: `/projects/${o.project_id}/observations`, label: "Observations" }} title={<>{o.title} <Badge value={o.status} /></>} sub={`${label(o.type)} · ${label(o.severity)} severity`} />
      <section className="card">
        <KeyValues items={[["Location", o.location], ["Assignee", o.assignee_name], ["Correct by", fmtDate(o.due_date)], ["Reported by", `${o.created_by_name ?? "—"}, ${fmtDateTime(o.created_at)}`], ["Description", o.description], ["Resolution", o.resolution]]} />
      </section>
      {canClose && (
        <Form ariaLabel="Close observation" submitLabel="Close observation" fields={[{ name: "resolution", label: "How it was resolved", type: "textarea", required: true }]}
          onSubmit={async (v) => { await api("POST", `/observations/${o.id}/close`, { resolution: v.resolution }); r.reload(); }} />
      )}
      <Attachments title="Photos" accept="image/*" entityType="observation" entityId={o.id} projectId={o.project_id} files={o.photos} onChange={r.reload} canAdd={canWrite(o.myRole) || o.assignee_id === o.myId} />
      <Comments entityType="observation" entityId={o.id} projectId={o.project_id} />
    </>
  );
}

// ---------------- Incidents ----------------

export function IncidentsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/incidents`);
  const [queued, setQueued] = useState(false);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Incidents</h2>
        {canWrite(project.myRole) && (
          <Creator label="Report incident">
            {(close) => (
              <Form ariaLabel="Report incident" submitLabel="Submit report" onCancel={close} initial={{ type: "near_miss", occurredAt: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) }}
                fields={[
                  { name: "title", label: "Title", required: true, full: true },
                  { name: "type", label: "Type", type: "select", required: true, options: ["injury", "near_miss", "property_damage", "environmental"].map((v) => ({ value: v, label: label(v) })) },
                  { name: "occurredAt", label: "When", type: "datetime-local", required: true },
                  { name: "location", label: "Location" },
                  { name: "injuredParty", label: "Injured party" },
                  { name: "description", label: "What happened", type: "textarea", required: true },
                  { name: "oshaRecordable", label: "OSHA recordable", type: "checkbox" },
                  { name: "lostTime", label: "Lost time", type: "checkbox" },
                ]}
                onSubmit={async (v) => {
                  const r = await createOrQueue(`/projects/${project.id}/incidents`, { ...v, occurredAt: new Date(v.occurredAt).toISOString(), location: v.location || null, injuredParty: v.injuredParty || null }, v.title);
                  setQueued(r.queued); close(); list.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <Queued show={queued} />
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(i) => `/incidents/${i.id}`} empty="No incidents reported." caption="Incidents" columns={[
          { label: "Title", render: (i) => i.title },
          { label: "When", render: (i) => fmtDateTime(i.occurred_at) },
          { label: "Type", render: (i) => label(i.type) },
          { label: "OSHA", render: (i) => (i.osha_recordable ? "Recordable" : "—") },
          { label: "Status", render: (i) => <Badge value={i.status} /> },
        ]} />
      </section>
    </>
  );
}

export function IncidentPage({ id }: { id: string }) {
  const r = useApi(`/incidents/${id}`);
  const i = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!i) return <Loading />;
  return (
    <>
      <PageHead back={{ to: `/projects/${i.project_id}/incidents`, label: "Incidents" }} title={<>{i.title} <Badge value={i.status} /></>} sub={`${label(i.type)} · ${fmtDateTime(i.occurred_at)}`} />
      <section className="card">
        <KeyValues items={[["Location", i.location], ["Injured party", i.injured_party], ["OSHA recordable", i.osha_recordable ? "Yes" : "No"], ["Lost time", i.lost_time ? "Yes" : "No"], ["Reported by", i.created_by_name], ["Description", i.description], ["Root cause", i.root_cause], ["Corrective action", i.corrective_action]]} />
      </section>
      {canManage(i.myRole) && (
        <Form ariaLabel="Investigation" submitLabel="Save investigation" initial={{ status: i.status, rootCause: i.root_cause ?? "", correctiveAction: i.corrective_action ?? "", oshaRecordable: i.osha_recordable, lostTime: i.lost_time }}
          fields={[
            { name: "status", label: "Status", type: "select", required: true, options: ["open", "investigating", "closed"].map((v) => ({ value: v, label: label(v) })) },
            { name: "rootCause", label: "Root cause", type: "textarea" },
            { name: "correctiveAction", label: "Corrective action", type: "textarea" },
            { name: "oshaRecordable", label: "OSHA recordable", type: "checkbox" },
            { name: "lostTime", label: "Lost time", type: "checkbox" },
          ]}
          onSubmit={async (v) => { await api("PATCH", `/incidents/${i.id}`, { ...v, rootCause: v.rootCause || null, correctiveAction: v.correctiveAction || null }); r.reload(); }} />
      )}
      <Attachments title="Photos" accept="image/*" entityType="incident" entityId={i.id} projectId={i.project_id} files={i.photos} onChange={r.reload} canAdd={canWrite(i.myRole)} />
      <Comments entityType="incident" entityId={i.id} projectId={i.project_id} />
    </>
  );
}

// ---------------- Photos ----------------

export function PhotosTool({ project }: { project: ProjectInfo }) {
  const photos = useApi<any[]>(`/projects/${project.id}/files?kind=image`);
  const { busy, error, run } = useAction();
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Photos</h2>
        {canWrite(project.myRole) && (
          <label className="upload button primary">
            <span>{busy ? "Uploading…" : "Upload photos"}</span>
            <input type="file" accept="image/*" multiple capture="environment" aria-label="Upload photos" disabled={busy}
              onChange={(e) => { const files = e.target.files; if (files?.length) run(async () => { for (const f of files) { const fd = new FormData(); fd.append("file", f, f.name); const res = await fetch(`/api/projects/${project.id}/files`, { method: "POST", headers: { "x-openbuild-csrf": "1" }, body: fd }); if (!res.ok) throw new Error((await res.json()).error); } }).then(photos.reload); }} />
          </label>
        )}
      </div>
      <ErrorText error={error ?? photos.error} />
      {!photos.data ? <Loading /> : photos.data.length === 0 ? <Empty>No photos yet.</Empty> : (
        <ul className="gallery">
          {photos.data.map((f) => (
            <li key={f.id}>
              <a href={`/api/files/${f.id}/download?inline=1`} target="_blank" rel="noopener"><img src={`/api/files/${f.id}/download?inline=1`} alt={f.name} loading="lazy" /></a>
              <div className="small">{f.name}</div>
              <div className="muted small">{fmtDateTime(f.created_at)} · {f.uploaded_by_name} · {fmtBytes(f.size)}</div>
              {f.linked_to && <div className="small">{f.linked_to.map((l: any) => label(l.type)).join(", ")}</div>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
