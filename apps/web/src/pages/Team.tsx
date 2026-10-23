import { useState } from "react";
import { api, fmtDate, label } from "../api";
import { ActionButton, DataTable, ErrorText, Form, PageHead } from "../components/ui";
import { useAction, useApi } from "../hooks";

interface ShareLink { text: string; url: string }

function ShareBox({ link, name }: { link: ShareLink | null; name: string }) {
  if (!link) return null;
  return (
    <div className="span-all notice" role="status">
      {link.text}
      {link.url && <input readOnly value={link.url} aria-label={name} onFocus={(e) => e.target.select()} />}
    </div>
  );
}

export function TeamPage({ orgId, myRole, myId }: { orgId: string; myRole: string; myId: string }) {
  const { data, error, reload } = useApi<{ members: any[]; invitations: any[] }>(`/orgs/${orgId}/members`);
  const projects = useApi<any[]>(`/orgs/${orgId}/projects`);
  const canInvite = myRole === "owner" || myRole === "admin";
  const [invite, setInvite] = useState<ShareLink | null>(null);
  const [reset, setReset] = useState<ShareLink | null>(null);
  const { error: actionError, run } = useAction();

  async function changeRole(userId: string, role: string) {
    if (await run(() => api("PATCH", `/orgs/${orgId}/members/${userId}`, { role }))) reload();
  }
  const canAdminister = (m: any) => m.id !== myId && m.role !== "owner" && (myRole === "owner" || (myRole === "admin" && m.role === "member"));

  return (
    <>
      <PageHead title="Team" />
      {canInvite && (
        <Form ariaLabel="Invite" submitLabel="Create invitation" resetOnSuccess initial={{ orgRole: "member", projectRole: "contributor" }}
          fields={[
            { name: "email", label: "Email", type: "email", required: true },
            { name: "company", label: "Company (e.g. subcontractor name)" },
            { name: "orgRole", label: "Company role", type: "select", required: true, options: [{ value: "member", label: "Member" }, ...(myRole === "owner" ? [{ value: "admin", label: "Admin" }] : [])] },
            { name: "projectId", label: "Add to project (optional)", type: "select", options: (projects.data ?? []).map((p) => ({ value: p.id, label: p.name })) },
            { name: "projectRole", label: "Project role", type: "select", required: true, options: ["manager", "contributor", "viewer", "subcontractor"].map((r) => ({ value: r, label: label(r) })) },
          ]}
          onSubmit={async (v) => {
            const r = await api("POST", `/orgs/${orgId}/invitations`, { email: v.email, company: v.company || null, orgRole: v.orgRole, projectId: v.projectId || null, projectRole: v.projectId ? v.projectRole : null });
            setInvite({ text: r.emailSent ? "Invitation emailed. You can also share this one-time link (valid 7 days):" : "Share this one-time link with the invitee (valid 7 days):", url: `${location.origin}${r.acceptPath}` });
            reload();
          }}>
          <ShareBox link={invite} name="Invitation link" />
        </Form>
      )}
      <ErrorText error={error ?? actionError} />
      <ShareBox link={reset} name="Reset link" />
      <section className="card">
        <h2>Members</h2>
        <DataTable rows={data?.members ?? null} caption="Members" columns={[
          { label: "Name", render: (m) => m.name },
          { label: "Email", render: (m) => m.email },
          { label: "Company", render: (m) => m.company ?? "—" },
          { label: "Role", render: (m) => myRole === "owner" && m.role !== "owner" ? (
            <select aria-label={`Company role of ${m.name}`} value={m.role} onChange={(e) => changeRole(m.id, e.target.value)}>
              <option value="admin">Admin</option><option value="member">Member</option>
            </select>
          ) : label(m.role) },
          { label: "Joined", render: (m) => fmtDate(m.created_at) },
          { label: "", render: (m) => canAdminister(m) && (
            <span className="row-actions">
              <ActionButton className="link" onClick={async () => {
                const r = await api("POST", `/orgs/${orgId}/members/${m.id}/reset-link`);
                setReset({ text: `${r.emailSent ? "Reset link emailed. " : ""}Password reset link for ${m.name} (valid 24 hours):`, url: `${location.origin}${r.resetPath}` });
              }}>Reset password</ActionButton>
              <ActionButton className="link" confirm={`Turn off two-factor login for ${m.name}? They will be signed out and can enrol again.`} onClick={async () => { await api("POST", `/orgs/${orgId}/members/${m.id}/reset-mfa`); setReset({ text: `Two-factor login was reset for ${m.name}.`, url: "" }); }}>Reset 2FA</ActionButton>
              <ActionButton className="link danger" confirm={`Remove ${m.name} from the company and all its projects?`} onClick={async () => { await api("DELETE", `/orgs/${orgId}/members/${m.id}`); reload(); }}>Remove</ActionButton>
            </span>
          ) },
        ]} />
        {!!data?.invitations.length && (
          <>
            <h2>Pending invitations</h2>
            <ul className="list">
              {data.invitations.map((i) => (
                <li key={i.id}>{i.email} <span className="muted">· {label(i.org_role)}{i.company ? ` · ${i.company}` : ""}{i.project_name && ` · ${label(i.project_role)} on ${i.project_name}`} · expires {fmtDate(i.expires_at)}</span></li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
