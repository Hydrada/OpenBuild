import { useState, type JSX } from "react";
import { api, fmtDate, label } from "../api";
import { Badge, DataTable, ErrorText, Form, Link, Loading } from "../components/ui";
import { CustomFields, canManage, canWrite, useMemberOptions } from "../components/records";
import { useAction, useApi } from "../hooks";
import { ActivityList } from "./Dashboard";
import { DrawingsTool, DocumentsTool, SpecsTool } from "./tools/docs";
import { RfisTool, SubmittalsTool } from "./tools/rfis";
import { DailyLogsTool, IncidentsTool, InspectionsTool, ObservationsTool, PhotosTool, PunchTool } from "./tools/field";
import { BiddingTool } from "./tools/bidding";
import { MeetingsTool, TimesheetsTool } from "./tools/meetings";
import { ModelsTool } from "./tools/models";
import { ScheduleTool } from "./tools/schedule";
import { ActionPlansTool, CoordinationIssuesTool, WarrantiesTool } from "./tools/closeout";
import { CorrespondenceTool, DirectCostsTool, EquipmentTool, TmTicketsTool } from "./tools/project-tools";
import { BudgetTool, ChangeEventsTool, ChangeOrdersTool, ContractsTool, InvoicesTool } from "./tools/financials";

export interface ProjectInfo { id: string; org_id: string; name: string; code: string | null; address: string | null; status: string; start_date: string | null; end_date: string | null; myRole: string }

interface Tool { id: string; label: string; group: string; external?: boolean; render: (p: ProjectInfo, reload: () => void) => JSX.Element }

const TOOLS: Tool[] = [
  { id: "home", label: "Home", group: "Project", render: (p) => <Home project={p} /> },
  { id: "schedule", label: "Schedule", group: "Project", render: (p) => <ScheduleTool project={p} /> },
  { id: "meetings", label: "Meetings", group: "Project", render: (p) => <MeetingsTool project={p} /> },
  { id: "correspondence", label: "Correspondence", group: "Project", external: true, render: (p) => <CorrespondenceTool project={p} /> },
  { id: "action-plans", label: "Action plans", group: "Project", external: true, render: (p) => <ActionPlansTool project={p} /> },
  { id: "team", label: "Team", group: "Project", render: (p) => <Team project={p} /> },
  { id: "activity", label: "Activity", group: "Project", render: (p) => <Activity projectId={p.id} /> },
  { id: "drawings", label: "Drawings", group: "Documents", external: true, render: (p) => <DrawingsTool project={p} /> },
  { id: "documents", label: "Documents", group: "Documents", render: (p) => <DocumentsTool project={p} /> },
  { id: "models", label: "Models (BIM)", group: "Documents", external: true, render: (p) => <ModelsTool project={p} /> },
  { id: "coordination-issues", label: "Coordination issues", group: "Documents", external: true, render: (p) => <CoordinationIssuesTool project={p} /> },
  { id: "warranties", label: "Warranties", group: "Documents", render: (p) => <WarrantiesTool project={p} /> },
  { id: "specs", label: "Specifications", group: "Documents", external: true, render: (p) => <SpecsTool project={p} /> },
  { id: "rfis", label: "RFIs", group: "Documents", external: true, render: (p) => <RfisTool project={p} /> },
  { id: "submittals", label: "Submittals", group: "Documents", external: true, render: (p) => <SubmittalsTool project={p} /> },
  { id: "daily-log", label: "Daily log", group: "Field", render: (p) => <DailyLogsTool project={p} /> },
  { id: "inspections", label: "Inspections", group: "Field", render: (p) => <InspectionsTool project={p} /> },
  { id: "punch", label: "Punch list", group: "Field", external: true, render: (p) => <PunchTool project={p} /> },
  { id: "observations", label: "Observations", group: "Field", external: true, render: (p) => <ObservationsTool project={p} /> },
  { id: "incidents", label: "Incidents", group: "Field", render: (p) => <IncidentsTool project={p} /> },
  { id: "photos", label: "Photos", group: "Field", render: (p) => <PhotosTool project={p} /> },
  { id: "timesheets", label: "Timesheets", group: "Field", external: true, render: (p) => <TimesheetsTool project={p} /> },
  { id: "tm-tickets", label: "T&M tickets", group: "Field", render: (p) => <TmTicketsTool project={p} /> },
  { id: "equipment", label: "Equipment", group: "Field", render: (p) => <EquipmentTool project={p} /> },
  { id: "bidding", label: "Bidding", group: "Financials", render: (p) => <BiddingTool project={p} /> },
  { id: "budget", label: "Budget", group: "Financials", render: (p) => <BudgetTool project={p} /> },
  { id: "contracts", label: "Contracts", group: "Financials", render: (p) => <ContractsTool project={p} /> },
  { id: "change-events", label: "Change events", group: "Financials", render: (p) => <ChangeEventsTool project={p} /> },
  { id: "change-orders", label: "Change orders", group: "Financials", render: (p) => <ChangeOrdersTool project={p} /> },
  { id: "invoices", label: "Invoices", group: "Financials", render: (p) => <InvoicesTool project={p} /> },
  { id: "direct-costs", label: "Direct costs", group: "Financials", render: (p) => <DirectCostsTool project={p} /> },
  { id: "settings", label: "Settings", group: "Project", render: (p, reload) => <Settings project={p} onSaved={reload} /> },
];

export function ProjectPage({ projectId, tool }: { projectId: string; tool: string }) {
  const project = useApi<ProjectInfo>(`/projects/${projectId}`);
  if (project.error) return <ErrorText error={project.error} />;
  const p = project.data;
  if (!p) return <Loading />;
  const sub = p.myRole === "subcontractor";
  const visible = TOOLS.filter((t) => (!sub || t.external) && (t.id !== "settings" || canManage(p.myRole)));
  const current = visible.find((t) => t.id === tool) ?? visible[0]!;
  const groups = [...new Set(visible.map((t) => t.group))];
  return (
    <div className="project">
      <header className="project-head">
        <h1>{p.name} <Badge value={p.status} /></h1>
        <p className="muted">
          {p.code && <>#{p.code} · </>}{p.address && <>{p.address} · </>}
          {fmtDate(p.start_date)} – {fmtDate(p.end_date)} · your role: <strong>{label(p.myRole)}</strong>
        </p>
      </header>
      <div className="project-body">
        <nav className="tool-nav" aria-label="Project tools">
          {groups.map((g) => (
            <div key={g}>
              <div className="tool-group">{g}</div>
              {visible.filter((t) => t.group === g).map((t) => (
                <Link key={t.id} to={`/projects/${p.id}/${t.id}`} className={t === current ? "active" : ""}>{t.label}</Link>
              ))}
            </div>
          ))}
        </nav>
        <section className="tool" aria-label={current.label}>{current.render(p, project.reload)}</section>
      </div>
    </div>
  );
}

function Home({ project }: { project: ProjectInfo }) {
  const tasks = useApi<any[]>(`/projects/${project.id}/tasks`);
  const { options } = useMemberOptions(project.id);
  const { run, error } = useAction();
  const writable = canWrite(project.myRole);
  return (
    <>
      <h2 className="tool-title">Tasks</h2>
      {writable && (
        <Form ariaLabel="New task" submitLabel="Add task" resetOnSuccess className="compact"
          fields={[
            { name: "title", label: "Task title", required: true, full: true },
            { name: "assigneeId", label: "Assignee", type: "select", options },
            { name: "dueDate", label: "Due date", type: "date" },
          ]}
          onSubmit={async (v) => { await api("POST", `/projects/${project.id}/tasks`, { title: v.title, assigneeId: v.assigneeId || null, dueDate: v.dueDate || null }); tasks.reload(); }} />
      )}
      <ErrorText error={error ?? tasks.error} />
      <section className="card">
        <DataTable rows={tasks.data} empty="No tasks yet." caption="Tasks" columns={[
          { label: "Task", render: (t) => <span className={t.status === "done" ? "struck" : ""}>{t.title}</span> },
          { label: "Assignee", render: (t) => t.assignee_name ?? "—" },
          { label: "Due", render: (t) => <span className={t.status !== "done" && t.due_date && t.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10) ? "overdue" : ""}>{fmtDate(t.due_date)}</span> },
          { label: "Status", render: (t) => writable ? (
            <select aria-label={`Status of ${t.title}`} value={t.status} onChange={(e) => run(() => api("PATCH", `/tasks/${t.id}`, { status: e.target.value })).then(tasks.reload)}>
              <option value="open">Open</option><option value="in_progress">In progress</option><option value="done">Done</option>
            </select>
          ) : <Badge value={t.status} /> },
        ]} />
      </section>
      <div className="actions left">
        <a className="button" href={`/api/projects/${project.id}/export/tasks.csv`}>Export CSV</a>
      </div>
    </>
  );
}

function Team({ project }: { project: ProjectInfo }) {
  const members = useApi<any[]>(`/projects/${project.id}/members`);
  const manage = canManage(project.myRole);
  const org = useApi<{ members: any[] }>(manage ? `/orgs/${project.org_id}/members` : null);
  const [add, setAdd] = useState({ userId: "", role: "contributor" });
  const { busy, error, run } = useAction();
  const candidates = org.data?.members.filter((m) => m.role === "member" && !members.data?.some((pm) => pm.id === m.id)) ?? [];
  const roles = ["manager", "contributor", "viewer", "subcontractor"];

  async function setRole(userId: string, role: string | null) {
    if (await run(() => api("PUT", `/projects/${project.id}/members/${userId}`, { role }))) members.reload();
  }

  return (
    <>
      <h2 className="tool-title">Project team</h2>
      <ErrorText error={error ?? members.error} />
      <section className="card">
        <DataTable rows={members.data} caption="Project team" columns={[
          { label: "Name", render: (m) => m.name },
          { label: "Company", render: (m) => m.company ?? "—" },
          { label: "Email", render: (m) => m.email },
          { label: "Role", render: (m) => manage && m.role !== "admin" ? (
            <select aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => setRole(m.id, e.target.value)}>
              {roles.map((r) => <option key={r} value={r}>{label(r)}</option>)}
            </select>
          ) : m.role === "admin" ? `Company ${m.org_role}` : label(m.role) },
          { label: "", render: (m) => manage && m.role !== "admin" ? <button className="link danger" onClick={() => setRole(m.id, null)}>Remove</button> : null },
        ]} />
        {manage && candidates.length > 0 && (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (add.userId) setRole(add.userId, add.role); }}>
            <select aria-label="Add member" value={add.userId} onChange={(e) => setAdd({ ...add, userId: e.target.value })}>
              <option value="">Add a company member…</option>
              {candidates.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.email})</option>)}
            </select>
            <select aria-label="Project role" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
              {roles.map((r) => <option key={r} value={r}>{label(r)}</option>)}
            </select>
            <button disabled={busy || !add.userId}>Add to project</button>
          </form>
        )}
      </section>
      <p className="muted small">Subcontractors see drawings and specifications, plus only the RFIs, submittals, punch items and observations assigned to them.</p>
    </>
  );
}

function Activity({ projectId }: { projectId: string }) {
  const { data, error } = useApi<any[]>(`/projects/${projectId}/activity`);
  return <><h2 className="tool-title">Activity</h2><section className="card"><ErrorText error={error} />{data ? <ActivityList items={data} /> : <Loading />}</section></>;
}

function Settings({ project, onSaved }: { project: ProjectInfo; onSaved: () => void }) {
  return (
    <>
      <h2 className="tool-title">Project settings</h2>
      <Form ariaLabel="Project settings" submitLabel="Save changes"
        initial={{ name: project.name, code: project.code ?? "", address: project.address ?? "", status: project.status, startDate: project.start_date?.slice(0, 10) ?? "", endDate: project.end_date?.slice(0, 10) ?? "" }}
        fields={[
          { name: "name", label: "Project name", required: true },
          { name: "code", label: "Project number" },
          { name: "address", label: "Address" },
          { name: "status", label: "Stage", type: "select", required: true, options: ["bidding", "active", "on_hold", "closed"].map((s) => ({ value: s, label: label(s) })) },
          { name: "startDate", label: "Start date", type: "date" },
          { name: "endDate", label: "Finish date", type: "date" },
        ]}
        onSubmit={async (v) => { await api("PATCH", `/projects/${project.id}`, { name: v.name, code: v.code || null, address: v.address || null, status: v.status, startDate: v.startDate || null, endDate: v.endDate || null }); onSaved(); }} />
      <CustomFields entityType="project" entityId={project.id} editable />
      <section className="card">
        <h2>Exports</h2>
        <p className="muted">CSV files open in any spreadsheet.</p>
        <div className="actions left wrap">
          {["rfis", "submittals", "punch-items", "tasks", "observations", "daily-logs"].map((k) => (
            <a key={k} className="button" href={`/api/projects/${project.id}/export/${k}.csv`}>{label(k.replace("-", "_"))}</a>
          ))}
          <a className="button" href={`/api/projects/${project.id}/budget.csv`}>Budget</a>
        </div>
      </section>
    </>
  );
}
