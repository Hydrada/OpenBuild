import { useState, type FormEvent } from "react";
import { api, fmtDate } from "../api";
import { Badge, Empty, ErrorText, Field } from "../components/ui";
import { useAction, useApi } from "../hooks";
import { ActivityList } from "./Dashboard";

type Tab = "tasks" | "team" | "activity" | "settings";

export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useApi(`/projects/${projectId}`);
  const [tab, setTab] = useState<Tab>("tasks");
  if (project.error) return <ErrorText error={project.error} />;
  const p = project.data;
  if (!p) return <p className="muted">Loading…</p>;
  const canWrite = p.myRole !== "viewer";
  const canManage = p.myRole === "admin" || p.myRole === "manager";
  const tabs: Tab[] = canManage ? ["tasks", "team", "activity", "settings"] : ["tasks", "team", "activity"];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{p.name} <Badge value={p.status} /></h1>
          <p className="muted">
            {p.code && <>#{p.code} · </>}{p.address && <>{p.address} · </>}
            {fmtDate(p.start_date)} – {fmtDate(p.end_date)} · your role: <strong>{p.myRole}</strong>
          </p>
        </div>
      </div>
      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === "tasks" && <Tasks projectId={projectId} canWrite={canWrite} />}
      {tab === "team" && <Team projectId={projectId} orgId={p.org_id} canManage={canManage} />}
      {tab === "activity" && <Activity projectId={projectId} />}
      {tab === "settings" && <Settings project={p} onSaved={project.reload} />}
    </>
  );
}

function Tasks({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const tasks = useApi<any[]>(`/projects/${projectId}/tasks`);
  const members = useApi<any[]>(`/projects/${projectId}/members`);
  const [f, setF] = useState({ title: "", assigneeId: "", dueDate: "" });
  const { busy, error, run } = useAction();

  async function add(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => api("POST", `/projects/${projectId}/tasks`, { title: f.title, assigneeId: f.assigneeId || null, dueDate: f.dueDate || null }));
    if (ok) {
      setF({ title: "", assigneeId: "", dueDate: "" });
      tasks.reload();
    }
  }
  async function setStatus(id: string, status: string) {
    await run(() => api("PATCH", `/tasks/${id}`, { status }));
    tasks.reload();
  }

  return (
    <section className="card">
      {canWrite && (
        <form className="inline-form" onSubmit={add} aria-label="New task">
          <input placeholder="New task" aria-label="Task title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
          <select aria-label="Assignee" value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
            <option value="">Unassigned</option>
            {members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <input type="date" aria-label="Due date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
          <button className="primary" disabled={busy}>Add task</button>
        </form>
      )}
      <ErrorText error={error ?? tasks.error} />
      {tasks.data && (tasks.data.length === 0 ? <Empty>No tasks yet.</Empty> : (
        <table className="table">
          <thead><tr><th>Task</th><th>Assignee</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>
            {tasks.data.map((t) => {
              const overdue = t.status !== "done" && t.due_date && t.due_date < new Date().toISOString().slice(0, 10);
              return (
                <tr key={t.id} className={t.status === "done" ? "done" : ""}>
                  <td>{t.title}</td>
                  <td>{t.assignee_name ?? "—"}</td>
                  <td className={overdue ? "overdue" : ""}>{fmtDate(t.due_date)}</td>
                  <td>
                    {canWrite ? (
                      <select aria-label={`Status of ${t.title}`} value={t.status} onChange={(e) => setStatus(t.id, e.target.value)}>
                        <option value="open">Open</option><option value="in_progress">In progress</option><option value="done">Done</option>
                      </select>
                    ) : <Badge value={t.status} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ))}
    </section>
  );
}

function Team({ projectId, orgId, canManage }: { projectId: string; orgId: string; canManage: boolean }) {
  const members = useApi<any[]>(`/projects/${projectId}/members`);
  const org = useApi<{ members: any[] }>(canManage ? `/orgs/${orgId}/members` : null);
  const [add, setAdd] = useState({ userId: "", role: "contributor" });
  const { busy, error, run } = useAction();
  const candidates = org.data?.members.filter((m) => m.role === "member" && !members.data?.some((pm) => pm.id === m.id)) ?? [];

  async function setRole(userId: string, role: string | null) {
    const ok = await run(() => api("PUT", `/projects/${projectId}/members/${userId}`, { role }));
    if (ok) members.reload();
  }

  return (
    <section className="card">
      <ErrorText error={error ?? members.error} />
      <table className="table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th>{canManage && <th />}</tr></thead>
        <tbody>
          {members.data?.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td>{m.email}</td>
              <td>
                {canManage && m.role !== "admin" ? (
                  <select aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => setRole(m.id, e.target.value)}>
                    <option value="manager">Manager</option><option value="contributor">Contributor</option><option value="viewer">Viewer</option>
                  </select>
                ) : m.role === "admin" ? `Org ${m.org_role}` : m.role}
              </td>
              {canManage && <td>{m.role !== "admin" && <button className="link danger" onClick={() => setRole(m.id, null)}>Remove</button>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && candidates.length > 0 && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (add.userId) setRole(add.userId, add.role); }}>
          <select aria-label="Add member" value={add.userId} onChange={(e) => setAdd({ ...add, userId: e.target.value })}>
            <option value="">Add a company member…</option>
            {candidates.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.email})</option>)}
          </select>
          <select aria-label="Project role" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
            <option value="manager">Manager</option><option value="contributor">Contributor</option><option value="viewer">Viewer</option>
          </select>
          <button disabled={busy || !add.userId}>Add to project</button>
        </form>
      )}
    </section>
  );
}

function Activity({ projectId }: { projectId: string }) {
  const { data, error } = useApi<any[]>(`/projects/${projectId}/activity`);
  return <section className="card"><ErrorText error={error} />{data && <ActivityList items={data} />}</section>;
}

function Settings({ project, onSaved }: { project: any; onSaved: () => void }) {
  const [f, setF] = useState({
    name: project.name, code: project.code ?? "", address: project.address ?? "", status: project.status,
    startDate: project.start_date?.slice(0, 10) ?? "", endDate: project.end_date?.slice(0, 10) ?? "",
  });
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setSaved(false); setF({ ...f, [k]: e.target.value }); };

  async function save(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => api("PATCH", `/projects/${project.id}`, {
      name: f.name, code: f.code || null, address: f.address || null, status: f.status, startDate: f.startDate || null, endDate: f.endDate || null,
    }));
    if (ok) { setSaved(true); onSaved(); }
  }

  return (
    <form className="card form-grid" onSubmit={save} aria-label="Project settings">
      <Field label="Project name"><input value={f.name} onChange={set("name")} required /></Field>
      <Field label="Project number"><input value={f.code} onChange={set("code")} /></Field>
      <Field label="Address"><input value={f.address} onChange={set("address")} /></Field>
      <Field label="Stage">
        <select value={f.status} onChange={set("status")}>
          <option value="bidding">Bidding</option><option value="active">Active</option>
          <option value="on_hold">On hold</option><option value="closed">Closed</option>
        </select>
      </Field>
      <Field label="Start date"><input type="date" value={f.startDate} onChange={set("startDate")} /></Field>
      <Field label="Finish date"><input type="date" value={f.endDate} onChange={set("endDate")} /></Field>
      <ErrorText error={error} />
      <div className="actions">{saved && <span className="ok">Saved</span>}<button className="primary" disabled={busy}>Save changes</button></div>
    </form>
  );
}
