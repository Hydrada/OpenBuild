import { useState, type FormEvent } from "react";
import { api, type Me } from "../api";
import { ErrorText, Field } from "../components/ui";
import { useAction, useApi } from "../hooks";
import { navigate } from "../router";

export function InvitePage({ token, me, onJoined }: { token: string; me: Me | null; onJoined: () => void }) {
  const { data: inv, error: loadError } = useApi<{ email: string; orgName: string; projectName: string | null; accountExists: boolean }>(
    `/invitations/${encodeURIComponent(token)}`,
  );
  const [form, setForm] = useState({ name: "", password: "" });
  const { busy, error, run } = useAction();

  async function accept(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => api("POST", `/invitations/${encodeURIComponent(token)}/accept`, inv?.accountExists ? undefined : form));
    if (ok) {
      onJoined();
      navigate("/");
    }
  }

  return (
    <main className="auth">
      <form className="card auth-card" onSubmit={accept}>
        <h1 className="brand">OpenBuild</h1>
        {loadError && <ErrorText error={loadError} />}
        {inv && (
          <>
            <h2>Join {inv.orgName}</h2>
            <p>
              You've been invited as <strong>{inv.email}</strong>
              {inv.projectName && <> to the project <strong>{inv.projectName}</strong></>}.
            </p>
            {inv.accountExists ? (
              me ? (
                <p className="muted">Signed in as {me.user.email}.</p>
              ) : (
                <p className="muted">You already have an account. <a href="/">Sign in</a>, then open this link again.</p>
              )
            ) : (
              <>
                <Field label="Your name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
                <Field label="Choose a password">
                  <input type="password" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete="new-password" />
                </Field>
              </>
            )}
            <ErrorText error={error} />
            <button className="primary" disabled={busy || (inv.accountExists && !me)}>Accept invitation</button>
          </>
        )}
      </form>
    </main>
  );
}
