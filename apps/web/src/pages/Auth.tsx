import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorText, Field } from "../components/ui";
import { useAction } from "../hooks";

export function AuthPage({ onAuthed, allowSignup }: { onAuthed: () => void; allowSignup: boolean }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [form, setForm] = useState({ email: "", password: "", name: "", orgName: "", code: "" });
  const [needCode, setNeedCode] = useState(false);
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(async () => {
      if (mode === "register") return api("POST", "/auth/register", { email: form.email, password: form.password, name: form.name, orgName: form.orgName });
      try {
        return await api("POST", "/auth/login", { email: form.email, password: form.password, ...(needCode ? { code: form.code } : {}) });
      } catch (e) {
        if ((e as Error).message.includes("authenticator") || (e as Error).message.includes("code is not valid")) setNeedCode(true);
        throw e;
      }
    });
    if (ok) onAuthed();
  }

  return (
    <main className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <h1 className="brand">OpenBuild</h1>
        <h2>{mode === "login" ? "Sign in" : "Create your organization"}</h2>
        {mode === "register" && (
          <>
            <Field label="Your name"><input value={form.name} onChange={set("name")} required autoComplete="name" /></Field>
            <Field label="Company name"><input value={form.orgName} onChange={set("orgName")} required autoComplete="organization" /></Field>
          </>
        )}
        <Field label="Email"><input type="email" value={form.email} onChange={set("email")} required autoComplete="email" /></Field>
        <Field label="Password">
          <input type="password" value={form.password} onChange={set("password")} required minLength={mode === "register" ? 10 : undefined}
            autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </Field>
        {needCode && mode === "login" && (
          <Field label="Authentication code (or a recovery code)"><input inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={set("code")} required autoFocus /></Field>
        )}
        <ErrorText error={error} />
        <button className="primary" disabled={busy}>{mode === "login" ? "Sign in" : "Create account"}</button>
        {allowSignup && (
          <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "New here? Create an organization" : "Already have an account? Sign in"}
          </button>
        )}
      </form>
    </main>
  );
}
