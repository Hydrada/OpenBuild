import { useState, type FormEvent } from "react";
import { api, fmtDate } from "../api";
import { Badge, Empty, ErrorText, Field, Link } from "../components/ui";
import { useAction, useApi } from "../hooks";
import { navigate } from "../router";

export function ProjectsPage({ orgId, canCreate }: { orgId: string; canCreate: boolean }) {
  const { data, error } = useApi<any[]>(`/orgs/${orgId}/projects`);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        {canCreate && <button className="primary" onClick={() => setCreating(true)}>New project</button>}
      </div>
      {creating && <NewProject orgId={orgId} onCancel={() => setCreating(false)} />}
      <ErrorText error={error} />
      {data && (data.length === 0 ? <Empty>No projects yet.</Empty> : (
        <table className="table">
          <thead><tr><th>Name</th><th>Code</th><th>Status</th><th>Start</th><th>Finish</th><th>Open tasks</th></tr></thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/projects/${p.id}`}>{p.name}</Link>{p.address && <div className="muted small">{p.address}</div>}</td>
                <td>{p.code ?? "—"}</td>
                <td><Badge value={p.status} /></td>
                <td>{fmtDate(p.start_date)}</td>
                <td>{fmtDate(p.end_date)}</td>
                <td>{p.open_tasks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </>
  );
}

function NewProject({ orgId, onCancel }: { orgId: string; onCancel: () => void }) {
  const [f, setF] = useState({ name: "", code: "", address: "", status: "active", startDate: "", endDate: "" });
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    let id = "";
    const ok = await run(async () => {
      const p = await api("POST", `/orgs/${orgId}/projects`, {
        name: f.name, code: f.code || null, address: f.address || null, status: f.status,
        startDate: f.startDate || null, endDate: f.endDate || null,
      });
      id = p.id;
    });
    if (ok) navigate(`/projects/${id}`);
  }

  return (
    <form className="card form-grid" onSubmit={submit} aria-label="New project">
      <Field label="Project name"><input value={f.name} onChange={set("name")} required autoFocus /></Field>
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
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy}>Create project</button>
      </div>
    </form>
  );
}
