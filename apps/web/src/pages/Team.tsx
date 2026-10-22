import { useState, type FormEvent } from "react";
import { api, fmtDate } from "../api";
import { ErrorText, Field } from "../components/ui";
import { useAction, useApi } from "../hooks";

export function TeamPage({ orgId, myRole }: { orgId: string; myRole: string }) {
  const { data, error, reload } = useApi<{ members: any[]; invitations: any[] }>(`/orgs/${orgId}/members`);
  const projects = useApi<any[]>(`/orgs/${orgId}/projects`);
  const canInvite = myRole === "owner" || myRole === "admin";
  const [f, setF] = useState({ email: "", orgRole: "member", projectId: "", projectRole: "contributor" });
  const [link, setLink] = useState<string | null>(null);
  const { busy, error: actionError, run } = useAction();

  async function invite(e: FormEvent) {
    e.preventDefault();
    let path = "";
    const ok = await run(async () => {
      const r = await api("POST", `/orgs/${orgId}/invitations`, {
        email: f.email, orgRole: f.orgRole,
        projectId: f.projectId || null, projectRole: f.projectId ? f.projectRole : null,
      });
      path = r.acceptPath;
    });
    if (ok) {
      setLink(`${location.origin}${path}`);
      setF({ ...f, email: "" });
      reload();
    }
  }

  async function changeRole(userId: string, role: string) {
    if (await run(() => api("PATCH", `/orgs/${orgId}/members/${userId}`, { role }))) reload();
  }

  return (
    <>
      <h1>Team</h1>
      {canInvite && (
        <form className="card form-grid" onSubmit={invite} aria-label="Invite">
          <h2 className="span-all">Invite someone</h2>
          <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
          <Field label="Company role">
            <select value={f.orgRole} onChange={(e) => setF({ ...f, orgRole: e.target.value })}>
              <option value="member">Member</option>
              {myRole === "owner" && <option value="admin">Admin</option>}
            </select>
          </Field>
          <Field label="Add to project (optional)">
            <select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
              <option value="">None</option>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          {f.projectId && (
            <Field label="Project role">
              <select value={f.projectRole} onChange={(e) => setF({ ...f, projectRole: e.target.value })}>
                <option value="manager">Manager</option><option value="contributor">Contributor</option><option value="viewer">Viewer</option>
              </select>
            </Field>
          )}
          <ErrorText error={actionError} />
          <div className="actions"><button className="primary" disabled={busy}>Create invitation</button></div>
          {link && (
            <div className="span-all notice">
              Share this one-time link with the invitee (valid 7 days):
              <input readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.target.select()} />
            </div>
          )}
        </form>
      )}
      <ErrorText error={error} />
      <section className="card">
        <h2>Members</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
          <tbody>
            {data?.members.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td><td>{m.email}</td>
                <td>
                  {myRole === "owner" && m.role !== "owner" ? (
                    <select aria-label={`Company role of ${m.name}`} value={m.role} onChange={(e) => changeRole(m.id, e.target.value)}>
                      <option value="admin">Admin</option><option value="member">Member</option>
                    </select>
                  ) : m.role}
                </td>
                <td>{fmtDate(m.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!!data?.invitations.length && (
          <>
            <h2>Pending invitations</h2>
            <ul className="list">
              {data.invitations.map((i) => (
                <li key={i.id}>{i.email} <span className="muted">· {i.org_role}{i.project_name && ` · ${i.project_role} on ${i.project_name}`} · expires {fmtDate(i.expires_at)}</span></li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
