import { useState } from "react";
import { api, fmtDate, fmtDateTime, label, today, upload } from "../../api";
import { Attachments, Comments, canManage, canWrite, useMemberOptions } from "../../components/records";
import { ActionButton, Badge, Creator, DataTable, ErrorText, Form, KeyValues, Loading, PageHead } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import { navigate } from "../../router";
import type { ProjectInfo } from "../Project";

// ---------------- Action plans (closeout and other checklists) ----------------

export function ActionPlansTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/action-plans`);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Action plans</h2>
        {canWrite(project.myRole) && (
          <Creator label="New action plan">
            {(close) => (
              <Form ariaLabel="New action plan" submitLabel="Create plan" onCancel={close} initial={{ kind: "closeout", useCloseoutTemplate: true }}
                fields={[
                  { name: "title", label: "Title", required: true, placeholder: "Project closeout" },
                  { name: "kind", label: "Type", type: "select", required: true, options: [
                    { value: "closeout", label: "Closeout" }, { value: "quality", label: "Quality" }, { value: "safety", label: "Safety" },
                    { value: "commissioning", label: "Commissioning" }, { value: "general", label: "General" }] },
                  { name: "useCloseoutTemplate", label: "Start from the standard closeout checklist (O&Ms, as-builts, warranties, lien waivers…)", type: "checkbox" },
                  { name: "items", label: "Extra items (one per line; \"Section: item\" to group)", type: "textarea", full: true },
                ]}
                onSubmit={async (v) => {
                  const items = String(v.items ?? "").split("\n").map((s) => s.trim()).filter(Boolean).map((line) => {
                    const m = line.match(/^([^:]{1,60}):\s*(.+)$/);
                    return m ? { section: m[1]!.trim(), title: m[2]! } : { title: line };
                  });
                  const p = await api("POST", `/projects/${project.id}/action-plans`, { title: v.title, kind: v.kind, useCloseoutTemplate: !!v.useCloseoutTemplate, items });
                  close(); list.reload();
                  navigate(`/action-plans/${p.id}`);
                }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(p) => `/action-plans/${p.id}`} empty="No action plans yet." caption="Action plans" columns={[
          { label: "Title", render: (p) => p.title },
          { label: "Type", render: (p) => label(p.kind) },
          { label: "Progress", render: (p) => <><progress max={p.items || 1} value={p.complete} aria-label={`${p.title} progress`} /> {p.complete}/{p.items}</> },
          { label: "Overdue", render: (p) => (p.overdue ? <span className="badge badge-rejected">{p.overdue}</span> : "—") },
        ]} />
      </section>
    </>
  );
}

function ItemFile({ item, projectId, onDone }: { item: any; projectId: string; onDone: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <label className="upload small">
      <span>{busy ? "Uploading…" : item.files ? `${item.files} file(s) · add` : "Attach"}</span>
      <input type="file" aria-label={`Attach file to ${item.title}`} disabled={busy} onChange={(e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        run(async () => {
          const file = await upload(`/projects/${projectId}/files`, {}, f);
          await api("POST", "/attachments", { entityType: "action_plan_item", entityId: item.id, fileId: file.id });
          onDone();
        });
      }} />
      <ErrorText error={error} />
    </label>
  );
}

export function ActionPlanPage({ id }: { id: string }) {
  const r = useApi(`/action-plans/${id}`);
  const p = r.data;
  const { options } = useMemberOptions(p?.project_id);
  const { error, run } = useAction();
  if (r.error) return <ErrorText error={r.error} />;
  if (!p) return <Loading />;
  const writer = canWrite(p.myRole);
  const manager = canManage(p.myRole);
  const sections = [...new Set<string>(p.items.map((i: any) => i.section))];
  const set = (itemId: string, body: object) => run(async () => { await api("PATCH", `/action-plan-items/${itemId}`, body); r.reload(); });
  return (
    <>
      <PageHead back={{ to: `/projects/${p.project_id}/action-plans`, label: "Action plans" }} title={p.title}
        sub={`${label(p.kind)} · ${p.progress.complete} of ${p.progress.total} complete (${p.progress.percent}%)`} />
      <progress className="wide" max={p.progress.total || 1} value={p.progress.complete} aria-label="Plan progress" />
      <ErrorText error={error} />
      {sections.map((s) => (
        <section className="card" key={s} aria-label={s}>
          <h2>{s}</h2>
          <DataTable rows={p.items.filter((i: any) => i.section === s)} caption={s} columns={[
            { label: "Item", render: (i: any) => <>{i.title}{i.requires_file && <span className="muted small"> · document required</span>}{i.notes && <div className="muted small">{i.notes}</div>}</> },
            { label: "Assignee", render: (i: any) => writer
              ? <select aria-label={`Assignee for ${i.title}`} value={i.assignee_id ?? ""} onChange={(e) => set(i.id, { assigneeId: e.target.value || null })}>
                  <option value="">Unassigned</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              : i.assignee_name ?? "—" },
            { label: "Due", render: (i: any) => fmtDate(i.due_date) },
            { label: "Files", render: (i: any) => (writer || i.assignee_id === p.myId) ? <ItemFile item={i} projectId={p.project_id} onDone={r.reload} /> : i.files },
            { label: "Status", render: (i: any) => <>
              <Badge value={i.status} />
              {i.completed_by_name && <div className="muted small">{i.completed_by_name} · {fmtDateTime(i.completed_at)}</div>}
            </> },
            { label: "", render: (i: any) => (writer || i.assignee_id === p.myId) && (
              <span className="row-actions">
                {i.status === "open" && <button type="button" onClick={() => set(i.id, { status: "done" })}>Mark done</button>}
                {i.status === "open" && manager && <button type="button" className="link" onClick={() => set(i.id, { status: "not_applicable" })}>N/A</button>}
                {i.status !== "open" && writer && <button type="button" className="link" onClick={() => set(i.id, { status: "open" })}>Reopen</button>}
              </span>
            ) },
          ]} />
        </section>
      ))}
      {writer && (
        <section className="card" aria-label="Add items">
          <h2>Add item</h2>
          <Form ariaLabel="Add action plan item" submitLabel="Add item" resetOnSuccess initial={{ section: sections[0] ?? "General" }}
            fields={[
              { name: "section", label: "Section", required: true },
              { name: "title", label: "Item", required: true },
              { name: "assigneeId", label: "Assignee", type: "select", options },
              { name: "dueDate", label: "Due", type: "date" },
              { name: "requiresFile", label: "Requires a document", type: "checkbox" },
            ]}
            onSubmit={async (v) => {
              await api("POST", `/action-plans/${id}/items`, [{ section: v.section, title: v.title, assigneeId: v.assigneeId || null, dueDate: v.dueDate || null, requiresFile: !!v.requiresFile }]);
              r.reload();
            }} />
        </section>
      )}
      {p.myRole !== "subcontractor" && <Comments entityType="action_plan" entityId={p.id} projectId={p.project_id} />}
    </>
  );
}

// ---------------- Warranties ----------------

export function WarrantiesTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/warranties`);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Warranties</h2>
        {canWrite(project.myRole) && (
          <Creator label="Add warranty">
            {(close) => (
              <Form ariaLabel="Add warranty" submitLabel="Add warranty" onCancel={close} initial={{ startDate: today() }}
                fields={[
                  { name: "item", label: "Item / system", required: true, placeholder: "Roofing membrane" },
                  { name: "company", label: "Warrantor", required: true },
                  { name: "specSection", label: "Spec section" },
                  { name: "startDate", label: "Starts", type: "date", required: true },
                  { name: "endDate", label: "Ends", type: "date", required: true },
                  { name: "contact", label: "Claims contact" },
                  { name: "notes", label: "Coverage notes", type: "textarea", full: true },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/warranties`, { item: v.item, company: v.company, specSection: v.specSection || null, startDate: v.startDate, endDate: v.endDate, contact: v.contact || null, notes: v.notes || null });
                  close(); list.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(w) => `/warranties/${w.id}`} empty="No warranties yet." caption="Warranties" columns={[
          { label: "Item", render: (w) => w.item },
          { label: "Warrantor", render: (w) => w.company },
          { label: "Spec", render: (w) => w.spec_section ?? "—" },
          { label: "Ends", render: (w) => fmtDate(w.end_date) },
          { label: "Documents", render: (w) => w.files },
          { label: "State", render: (w) => <Badge value={w.state} /> },
        ]} />
      </section>
    </>
  );
}

export function WarrantyPage({ id }: { id: string }) {
  const r = useApi(`/warranties/${id}`);
  const w = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!w) return <Loading />;
  return (
    <>
      <PageHead back={{ to: `/projects/${w.project_id}/warranties`, label: "Warranties" }} title={w.item} sub={`${w.company} · ${fmtDate(w.start_date)} – ${fmtDate(w.end_date)}`} />
      <section className="card">
        <KeyValues items={[["Spec section", w.spec_section ?? "—"], ["Claims contact", w.contact ?? "—"], ["Coverage", <span className="pre">{w.notes ?? "—"}</span>]]} />
      </section>
      <Attachments entityType="warranty" entityId={w.id} projectId={w.project_id} files={w.files} onChange={r.reload} canAdd={canWrite(w.myRole)} title="Warranty documents" />
    </>
  );
}

// ---------------- Coordination issues ----------------

const ISSUE_TYPES = [
  { value: "clash", label: "Clash" }, { value: "design", label: "Design" }, { value: "constructability", label: "Constructability" },
  { value: "missing_information", label: "Missing information" }, { value: "other", label: "Other" },
];
const PRIORITIES = [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }];

export function CoordinationIssuesTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/coordination-issues`);
  const { options } = useMemberOptions(project.id);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Coordination issues</h2>
        {canWrite(project.myRole) && (
          <Creator label="New issue">
            {(close) => (
              <Form ariaLabel="New coordination issue" submitLabel="Create issue" onCancel={close} initial={{ type: "design", priority: "medium" }}
                fields={[
                  { name: "title", label: "Title", required: true, full: true },
                  { name: "type", label: "Type", type: "select", required: true, options: ISSUE_TYPES },
                  { name: "priority", label: "Priority", type: "select", required: true, options: PRIORITIES },
                  { name: "assigneeId", label: "Assignee", type: "select", options },
                  { name: "dueDate", label: "Due", type: "date" },
                  { name: "location", label: "Location" },
                  { name: "description", label: "Description", type: "textarea", full: true },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/coordination-issues`, { title: v.title, type: v.type, priority: v.priority, assigneeId: v.assigneeId || null, dueDate: v.dueDate || null, location: v.location || null, description: v.description || null });
                  close(); list.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <p className="muted small">Raise issues straight from a clash run in Models (BIM).</p>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(i) => `/coordination-issues/${i.id}`} empty="No coordination issues." caption="Coordination issues" columns={[
          { label: "#", render: (i) => i.number },
          { label: "Title", render: (i) => i.title },
          { label: "Type", render: (i) => label(i.type) },
          { label: "Priority", render: (i) => <Badge value={i.priority} /> },
          { label: "Assignee", render: (i) => i.assignee_name ?? "—" },
          { label: "Due", render: (i) => fmtDate(i.due_date) },
          { label: "Status", render: (i) => <Badge value={i.status} /> },
        ]} />
      </section>
    </>
  );
}

export function CoordinationIssuePage({ id }: { id: string }) {
  const r = useApi(`/coordination-issues/${id}`);
  const i = r.data;
  const { options } = useMemberOptions(i?.project_id);
  const { error, run } = useAction();
  if (r.error) return <ErrorText error={r.error} />;
  if (!i) return <Loading />;
  const writer = canWrite(i.myRole);
  const assignee = i.assignee_id === i.myId;
  const canClose = canManage(i.myRole) || i.created_by === i.myId;
  const set = (body: object) => run(async () => { await api("PATCH", `/coordination-issues/${id}`, body); r.reload(); });
  return (
    <>
      <PageHead back={{ to: `/projects/${i.project_id}/coordination-issues`, label: "Coordination issues" }}
        title={<>#{i.number} {i.title} <Badge value={i.status} /></>}
        sub={`${label(i.type)} · ${label(i.priority)} priority · raised by ${i.created_by_name ?? "—"} ${fmtDateTime(i.created_at)}`}
        actions={<>
          {i.status === "open" && (assignee || writer) && <ActionButton onClick={() => set({ status: "in_progress" })}>Start work</ActionButton>}
          {(i.status === "open" || i.status === "in_progress") && (assignee || writer) && <ActionButton className="primary" onClick={() => set({ status: "ready_for_review" })}>Ready for review</ActionButton>}
          {i.status !== "closed" && canClose && <ActionButton className="primary" onClick={() => set({ status: "closed" })}>Close</ActionButton>}
          {i.status === "closed" && writer && <ActionButton onClick={() => set({ status: "open" })}>Reopen</ActionButton>}
        </>} />
      <ErrorText error={error} />
      <section className="card">
        <KeyValues items={[
          ["Assignee", writer
            ? <select aria-label="Assignee" value={i.assignee_id ?? ""} onChange={(e) => set({ assigneeId: e.target.value || null })}><option value="">Unassigned</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            : i.assignee_name ?? "—"],
          ["Due", fmtDate(i.due_date)],
          ["Location", i.location ?? "—"],
          ["Description", <span className="pre">{i.description ?? "—"}</span>],
          ["Model elements", i.elements.length ? i.elements.map((e: any) => `${e.name ?? e.id} (${e.type})`).join(" × ") : "—"],
        ]} />
      </section>
      <Attachments entityType="coordination_issue" entityId={i.id} projectId={i.project_id} files={i.files} onChange={r.reload} canAdd={writer || assignee} />
      <Comments entityType="coordination_issue" entityId={i.id} projectId={i.project_id} />
    </>
  );
}

/** Raise coordination issues from a clash run (one per clash; already-raised clashes are skipped). */
export function RaiseIssues({ runId, indexes, label: text = "Raise issue" }: { runId: string; indexes: number[]; label?: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span>
      <ActionButton className="link" onClick={async () => {
        const res = await api("POST", `/clash-runs/${runId}/issues`, { indexes });
        setMsg(res.created ? `${res.created} issue(s) raised` : "Already raised");
      }}>{text}</ActionButton>
      {msg && <span className="muted small" role="status"> {msg}</span>}
    </span>
  );
}

// ---------------- Payroll export ----------------

export function PayrollExport({ projectId }: { projectId: string }) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("en-CA");
  const [range, setRange] = useState({ from: first, to: today() });
  const preview = useApi(`/projects/${projectId}/timesheets/payroll?from=${range.from}&to=${range.to}`);
  const { error, run } = useAction();
  const [marked, setMarked] = useState<number | null>(null);
  const rows: any[] = preview.data?.rows ?? [];
  const sumOf = (k: string) => rows.reduce((a, x) => a + Number(x[k]), 0).toFixed(2);
  return (
    <section className="card" aria-label="Payroll export">
      <h2>Payroll export</h2>
      <div className="row">
        <label>From <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label>To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <a className="button" href={`/api/projects/${projectId}/timesheets/payroll.csv?from=${range.from}&to=${range.to}`}>Download CSV</a>
        <ActionButton onClick={() => run(async () => { const r = await api("POST", `/projects/${projectId}/timesheets/mark-exported`, range); setMarked(r.marked); preview.reload(); })}>Mark as sent to payroll</ActionButton>
      </div>
      <ErrorText error={preview.error ?? error} />
      <p className="muted small">Approved hours only. Hours past 40 in a Monday–Sunday week are overtime.
        {" "}{rows.length} entries · regular {sumOf("regular")} h · overtime {sumOf("overtime")} h
        {preview.data?.alreadyExported ? ` · ${preview.data.alreadyExported} already sent to payroll` : ""}
        {marked !== null && <span role="status"> · {marked} marked as sent</span>}</p>
    </section>
  );
}
