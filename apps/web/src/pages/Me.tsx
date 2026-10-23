import { PermissionTemplatesSection } from "./PermissionTemplates";
import { FormTemplatesSection } from "./tools/forms";
import { useState } from "react";
import { api, fmtDate, fmtDateTime, label } from "../api";
import { ActionButton, Badge, DataTable, Empty, ErrorText, Form, Link, Loading, PageHead } from "../components/ui";
import { useApi } from "../hooks";
import { discard, syncOutbox, useOutbox } from "../offline";
import { navigate } from "../router";

const LINK: Record<string, string> = { document: "documents", submittal: "submittals", change_order: "change-orders", invoice: "invoices" };

/** Normalises stored notification links (/change_orders/x, /punch_items/x …) to app routes. */
export function routeFor(link: string | null) {
  if (!link) return "/";
  return link.replace(/^\/(punch_items|punch-items)\//, "/punch/").replace(/_/g, "-");
}

export function NotificationsPage({ onRead }: { onRead: () => void }) {
  const n = useApi<{ unread: number; items: any[] }>("/me/notifications");
  return (
    <>
      <PageHead title="Notifications" actions={n.data?.unread ? <ActionButton onClick={async () => { await api("POST", "/me/notifications/read", {}); n.reload(); onRead(); }}>Mark all read</ActionButton> : null} />
      <ErrorText error={n.error} />
      <section className="card">
        {!n.data ? <Loading /> : n.data.items.length === 0 ? <Empty>You're all caught up.</Empty> : (
          <ul className="list notifications">
            {n.data.items.map((x) => (
              <li key={x.id} className={x.read_at ? "" : "unread"}>
                <a href={routeFor(x.link)} onClick={async (e) => {
                  e.preventDefault();
                  if (!x.read_at) { await api("POST", "/me/notifications/read", { ids: [x.id] }); onRead(); }
                  navigate(routeFor(x.link));
                }}>{x.title}</a>
                <div className="muted small">{x.project_name ?? ""} · {x.actor_name ?? ""} · {fmtDateTime(x.created_at)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function MyWorkPage() {
  const w = useApi("/me/work");
  const approvals = useApi<any[]>("/me/approvals");
  const { items, online } = useOutbox();
  return (
    <>
      <PageHead title="My work" sub="Everything assigned to you across projects." />
      {(items.length > 0 || !online) && (
        <section className="card" aria-label="Offline outbox">
          <h2>Waiting to sync {!online && <span className="badge badge-on_hold">Offline</span>}</h2>
          {items.length === 0 ? <Empty>Nothing queued.</Empty> : (
            <ul className="list">
              {items.map((i) => (
                <li key={i.clientId}>{i.label} <span className="muted small">queued {fmtDateTime(i.queuedAt)}</span>
                  {i.lastError && <><span className="error"> — {i.lastError}</span> <button className="link danger" onClick={() => discard(i.clientId)}>Discard</button></>}
                </li>
              ))}
            </ul>
          )}
          {online && items.length > 0 && <button onClick={() => void syncOutbox()}>Sync now</button>}
        </section>
      )}
      <section className="card">
        <h2>Approvals waiting on you</h2>
        {!approvals.data ? <Loading /> : approvals.data.length === 0 ? <Empty>Nothing to approve.</Empty> : (
          <ul className="list">{approvals.data.map((a) => <li key={a.id}><Link to={`/${LINK[a.entity_type]}/${a.entity_id}`}>{a.title}</Link> <span className="muted small">{label(a.entity_type)} · since {fmtDate(a.created_at)}</span></li>)}</ul>
        )}
      </section>
      {w.data && (
        <div className="grid-2">
          <WorkList title="RFIs in your court" rows={w.data.rfis} href={(r) => `/rfis/${r.id}`} render={(r) => `RFI #${r.number}: ${r.title}`} />
          <WorkList title="Punch items" rows={w.data.punch} href={(r) => `/punch/${r.id}`} render={(r) => `#${r.number} ${r.title}`} />
          <WorkList title="Observations to correct" rows={w.data.observations} href={(r) => `/observations/${r.id}`} render={(r) => r.title} />
          <WorkList title="Tasks" rows={w.data.tasks} href={(r) => `/projects/${r.project_id}`} render={(r) => r.title} />
        </div>
      )}
    </>
  );
}

function WorkList({ title, rows, href, render }: { title: string; rows: any[]; href: (r: any) => string; render: (r: any) => string }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? <Empty>Nothing open.</Empty> : (
        <ul className="list">{rows.map((r) => <li key={r.id}><Link to={href(r)}>{render(r)}</Link> <span className="muted small">{r.project_name} · due {fmtDate(r.due_date)}</span></li>)}</ul>
      )}
    </section>
  );
}

function TwoFactor({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <section className="card" aria-label="Two-factor login">
      <h2>Two-factor login {enabled ? <Badge value="active" /> : null}</h2>
      {codes && (
        <div className="notice" role="status">
          <strong>Save these recovery codes now.</strong> Each signs you in once if you lose your phone; they will not be shown again.
          <ul className="recovery" aria-label="Recovery codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
        </div>
      )}
      {enabled ? (
        <Form ariaLabel="Turn off two-factor login" submitLabel="Turn off two-factor login" className="flat"
          fields={[{ name: "password", label: "Password", type: "password", required: true }, { name: "code", label: "Current 6-digit code", required: true }]}
          onSubmit={async (v) => { await api("POST", "/me/mfa/disable", v); onChange(); }} />
      ) : setup ? (
        <>
          <p>Add this key to an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>
          <p><code className="secret" aria-label="Setup key">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code></p>
          <p className="muted small">Or open this link on the phone: <a href={setup.otpauthUrl}>add to authenticator</a></p>
          <Form ariaLabel="Confirm two-factor login" submitLabel="Turn on two-factor login" className="flat"
            fields={[{ name: "code", label: "6-digit code", required: true }]}
            onSubmit={async (v) => { const r = await api("POST", "/me/mfa/enable", { code: v.code }); setCodes(r.recoveryCodes); setSetup(null); onChange(); }} />
        </>
      ) : (
        <>
          <p className="muted">Require a code from an authenticator app in addition to your password.</p>
          <ActionButton className="primary" onClick={async () => setSetup(await api("POST", "/me/mfa/setup"))}>Set up two-factor login</ActionButton>
        </>
      )}
    </section>
  );
}

export function AccountPage({ me, onChange }: { me: { user: { name: string; email: string; mfaEnabled?: boolean } }; onChange: () => void }) {
  const sessions = useApi<any[]>("/me/sessions");
  const [done, setDone] = useState(false);
  return (
    <>
      <PageHead title="Account" sub={`${me.user.name} · ${me.user.email}`} />
      <TwoFactor enabled={!!me.user.mfaEnabled} onChange={onChange} />
      <Form ariaLabel="Change password" submitLabel="Change password" resetOnSuccess
        fields={[{ name: "currentPassword", label: "Current password", type: "password", required: true }, { name: "newPassword", label: "New password (10+ characters)", type: "password", required: true }]}
        onSubmit={async (v) => { setDone(false); await api("POST", "/me/password", v); setDone(true); sessions.reload(); }}>
        {done && <p className="ok span-all" role="status">Password changed. Other devices were signed out.</p>}
      </Form>
      <section className="card">
        <h2>Signed-in devices</h2>
        <DataTable rows={sessions.data} caption="Sessions" columns={[
          { label: "Device", render: (s) => <span className="small">{s.user_agent ?? "Unknown"}</span> },
          { label: "Signed in", render: (s) => fmtDateTime(s.created_at) },
          { label: "Expires", render: (s) => fmtDate(s.expires_at) },
          { label: "", render: (s) => s.current ? <Badge value="active" /> : <ActionButton className="link danger" onClick={async () => { await api("DELETE", `/me/sessions/${s.id}`); sessions.reload(); }}>Sign out</ActionButton> },
        ]} />
        <div className="actions">
          <ActionButton className="danger" confirm="Sign out of every device, including this one?" onClick={async () => { await api("POST", "/auth/logout-all"); location.assign("/"); }}>Sign out everywhere</ActionButton>
        </div>
      </section>
    </>
  );
}

export function ResetPasswordPage({ token }: { token: string }) {
  const info = useApi<{ email: string }>(`/password-resets/${encodeURIComponent(token)}`);
  const [done, setDone] = useState(false);
  return (
    <main className="auth">
      <div className="auth-card">
        <h1 className="brand">OpenBuild</h1>
        <ErrorText error={info.error} />
        {done ? <p className="card">Password updated. <a href="/">Sign in</a></p> : info.data && (
          <Form ariaLabel="Set a new password" submitLabel="Set password"
            fields={[{ name: "password", label: `New password for ${info.data.email}`, type: "password", required: true }]}
            onSubmit={async (v) => { await api("POST", `/password-resets/${encodeURIComponent(token)}`, { password: v.password }); setDone(true); }} />
        )}
      </div>
    </main>
  );
}

export function OrgSettingsPage({ orgId }: { orgId: string }) {
  const keys = useApi<any[]>(`/orgs/${orgId}/api-keys`);
  const fields = useApi<any[]>(`/orgs/${orgId}/custom-fields`);
  const templates = useApi<any[]>(`/orgs/${orgId}/inspection-templates`);
  const [secret, setSecret] = useState<string | null>(null);
  return (
    <>
      <PageHead title="Company settings" />
      <section className="card" aria-label="API keys">
        <h2>API keys</h2>
        <p className="muted">Keys act as you, only within this company. Send <code>Authorization: Bearer &lt;key&gt;</code>. See docs/API.md.</p>
        <DataTable rows={keys.data} empty="No API keys." caption="API keys" columns={[
          { label: "Name", render: (k) => k.name }, { label: "Key", render: (k) => <code>{k.prefix}…</code> },
          { label: "Owner", render: (k) => k.owner_name }, { label: "Last used", render: (k) => fmtDateTime(k.last_used_at) },
          { label: "Status", render: (k) => k.revoked_at ? <Badge value="void" /> : <Badge value="active" /> },
          { label: "", render: (k) => !k.revoked_at && <ActionButton className="link danger" confirm="Revoke this key?" onClick={async () => { await api("DELETE", `/orgs/${orgId}/api-keys/${k.id}`); keys.reload(); }}>Revoke</ActionButton> },
        ]} />
        <Form ariaLabel="Create API key" submitLabel="Create key" resetOnSuccess className="flat"
          fields={[{ name: "name", label: "Key name", required: true }, { name: "expiresInDays", label: "Expires in days (optional)", type: "number", min: "1" }]}
          onSubmit={async (v) => { const k = await api("POST", `/orgs/${orgId}/api-keys`, { name: v.name, ...(v.expiresInDays ? { expiresInDays: Number(v.expiresInDays) } : {}) }); setSecret(k.secret); keys.reload(); }} />
        {secret && <div className="notice">Copy this key now — it will not be shown again: <input readOnly aria-label="New API key" value={secret} onFocus={(e) => e.target.select()} /></div>}
      </section>
      <section className="card" aria-label="Custom fields">
        <h2>Custom fields</h2>
        <DataTable rows={fields.data} empty="No custom fields." caption="Custom fields" columns={[
          { label: "Applies to", render: (f) => label(f.entity_type) }, { label: "Label", render: (f) => f.label }, { label: "Key", render: (f) => <code>{f.key}</code> },
          { label: "Type", render: (f) => `${f.type}${f.options.length ? `: ${f.options.join(", ")}` : ""}` }, { label: "Required", render: (f) => (f.required ? "Yes" : "No") },
          { label: "", render: (f) => <ActionButton className="link danger" confirm="Delete this field and its values?" onClick={async () => { await api("DELETE", `/orgs/${orgId}/custom-fields/${f.id}`); fields.reload(); }}>Delete</ActionButton> },
        ]} />
        <Form ariaLabel="Add custom field" submitLabel="Add field" resetOnSuccess className="flat" initial={{ entityType: "rfi", type: "text" }}
          fields={[
            { name: "entityType", label: "Applies to", type: "select", required: true, options: ["project", "rfi", "submittal", "punch_item", "observation", "task"].map((v) => ({ value: v, label: label(v) })) },
            { name: "label", label: "Label", required: true },
            { name: "key", label: "Key (lowercase_with_underscores)", required: true },
            { name: "type", label: "Type", type: "select", required: true, options: ["text", "number", "date", "select", "boolean"].map((v) => ({ value: v, label: label(v) })) },
            { name: "options", label: "Options for select (comma separated)" },
            { name: "required", label: "Required", type: "checkbox" },
          ]}
          onSubmit={async (v) => { await api("POST", `/orgs/${orgId}/custom-fields`, { ...v, options: v.options ? String(v.options).split(",").map((s) => s.trim()).filter(Boolean) : [] }); fields.reload(); }} />
      </section>
      <section className="card" aria-label="Inspection templates">
        <h2>Inspection templates</h2>
        {templates.data?.length ? <ul className="list">{templates.data.map((t) => <li key={t.id}><strong>{t.name}</strong> <span className="muted small">{t.items.length} items: {t.items.slice(0, 4).join("; ")}{t.items.length > 4 ? "…" : ""}</span></li>)}</ul> : <Empty>No templates yet.</Empty>}
        <Form ariaLabel="New inspection template" submitLabel="Create template" resetOnSuccess className="flat"
          fields={[{ name: "name", label: "Template name", required: true }, { name: "items", label: "Checklist items (one per line)", type: "textarea", required: true }]}
          onSubmit={async (v) => { await api("POST", `/orgs/${orgId}/inspection-templates`, { name: v.name, items: String(v.items).split("\n").map((s) => s.trim()).filter(Boolean) }); templates.reload(); }} />
      </section>
      <PermissionTemplatesSection orgId={orgId} />
      <FormTemplatesSection orgId={orgId} />
    </>
  );
}
