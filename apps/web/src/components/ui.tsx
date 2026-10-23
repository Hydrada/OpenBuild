import { useId, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { fmtMoney, label } from "../api";
import { useAction } from "../hooks";
import { navigate } from "../router";

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return <span className={`badge badge-${value}`}>{label(value)}</span>;
}

export function Money({ value, signed }: { value: string | null | undefined; signed?: boolean }) {
  const neg = value?.startsWith("-");
  return <span className={`money ${signed && neg ? "neg" : ""}`}>{fmtMoney(value)}</span>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

/** Wraps a single control; prefer Form for anything with selects (explicit label/for avoids option text leaking into the name). */
export function Field({ label, children, full }: { label: string; children: ReactNode; full?: boolean }) {
  return (
    <label className={`field ${full ? "span-all" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Loading() {
  return <p className="muted" aria-busy="true">Loading…</p>;
}

export function PageHead({ title, sub, actions, back }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="page-head">
      <div>
        {back && <Link to={back.to} className="back">← {back.label}</Link>}
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export interface Column<T> {
  label: string;
  render: (row: T) => ReactNode;
  className?: string;
}

/** Table whose rows link to `href(row)` (keyboard accessible via the first-cell link). */
export function DataTable<T extends { id?: string }>({ rows, columns, href, empty = "Nothing here yet.", caption }: {
  rows: T[] | null; columns: Column<T>[]; href?: (row: T) => string; empty?: string; caption?: string;
}) {
  if (!rows) return <Loading />;
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{columns.map((c) => <th key={c.label} scope="col">{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} className={href ? "clickable" : ""} onClick={href ? (e) => { if ((e.target as HTMLElement).closest("a,button,select,input")) return; navigate(href(r)); } : undefined}>
              {columns.map((c, j) => (
                <td key={c.label} className={c.className}>
                  {j === 0 && href ? <Link to={href(r)}>{c.render(r)}</Link> : c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type FieldType = "text" | "textarea" | "date" | "number" | "select" | "multiselect" | "checkbox" | "datetime-local" | "email" | "password" | "file" | "money";
export interface FieldSpec {
  name: string;
  label: string;
  type?: FieldType;
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  full?: boolean;
  accept?: string;
  min?: string;
  max?: string;
  step?: string;
}
export type FormValues = Record<string, any>;

/** Declarative form: renders labelled inputs, collects values, shows busy/error state. */
export function Form({ fields, initial = {}, submitLabel, onSubmit, onCancel, resetOnSuccess, ariaLabel, children, className }: {
  fields: FieldSpec[]; initial?: FormValues; submitLabel: string; onSubmit: (v: FormValues) => Promise<unknown>;
  onCancel?: () => void; resetOnSuccess?: boolean; ariaLabel?: string; children?: ReactNode; className?: string;
}) {
  const blank = () => Object.fromEntries(fields.map((f) => [f.name, initial[f.name] ?? (f.type === "checkbox" ? false : f.type === "file" ? null : f.type === "multiselect" ? [] : "")]));
  const [v, setV] = useState<FormValues>(blank);
  const [formKey, setFormKey] = useState(0);
  const uid = useId();
  const { busy, error, run } = useAction();
  const set = (name: string, value: unknown) => setV((cur) => ({ ...cur, [name]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => onSubmit(v));
    if (ok && resetOnSuccess) {
      setV(blank());
      setFormKey((k) => k + 1);
    }
  }

  return (
    <form key={formKey} className={`card form-grid ${className ?? ""}`} onSubmit={submit} aria-label={ariaLabel ?? submitLabel}>
      {fields.map((f) => {
        const common = { id: `${uid}-${f.name}`, required: f.required, placeholder: f.placeholder };
        let input: ReactNode;
        switch (f.type) {
          case "textarea":
            input = <textarea {...common} rows={4} value={v[f.name]} onChange={(e) => set(f.name, e.target.value)} />;
            break;
          case "select":
            input = (
              <select {...common} value={v[f.name]} onChange={(e) => set(f.name, e.target.value)}>
                {/* Required selects without a value get a non-selectable prompt so the shown choice always matches state. */}
                {!f.required ? <option value="">—</option> : v[f.name] === "" && <option value="" disabled>Choose…</option>}
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
            break;
          case "multiselect":
            input = (
              <select {...common} multiple size={Math.min(5, Math.max(2, f.options?.length ?? 2))} value={v[f.name]} onChange={(e) => set(f.name, [...e.target.selectedOptions].map((o) => o.value))}>
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
            break;
          case "checkbox":
            return (
              <label key={f.name} className="check">
                <input type="checkbox" checked={!!v[f.name]} onChange={(e) => set(f.name, e.target.checked)} /> {f.label}
              </label>
            );
          case "file":
            input = <input {...common} type="file" accept={f.accept} onChange={(e) => set(f.name, e.target.files?.[0] ?? null)} />;
            break;
          case "money":
            input = <input {...common} inputMode="decimal" pattern="-?[0-9,]*(\.[0-9]{0,2})?" title="Amount with up to 2 decimals" value={v[f.name]} onChange={(e) => set(f.name, e.target.value)} />;
            break;
          default:
            input = <input {...common} type={f.type ?? "text"} min={f.min} max={f.max} step={f.step} value={v[f.name]} onChange={(e) => set(f.name, e.target.value)} />;
        }
        return (
          <div key={f.name} className={`field ${f.full || f.type === "textarea" ? "span-all" : ""}`}>
            <label htmlFor={`${uid}-${f.name}`}>{f.label}</label>
            {input}
          </div>
        );
      })}
      {children}
      <ErrorText error={error} />
      <div className="actions">
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <button className="primary" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
      </div>
    </form>
  );
}

/** "New X" button that expands into a form. */
export function Creator({ label: text, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return open ? <>{children(() => setOpen(false))}</> : <button className="primary" onClick={() => setOpen(true)}>{text}</button>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? "active" : ""} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </nav>
  );
}

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v ?? "—"}</dd></div>
      ))}
    </dl>
  );
}

/** Button that runs an async action; with `confirm`, it first asks inline (no blocking browser dialog). */
export function ActionButton({ children, onClick, className, confirm: confirmText }: { children: ReactNode; onClick: () => Promise<unknown>; className?: string; confirm?: string }) {
  const { busy, error, run } = useAction();
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="action-button confirming" role="group" aria-label="Confirm action">
        <span className="confirm-text">{confirmText}</span>
        <span className="confirm-buttons">
          <button className={className?.includes("danger") ? "danger" : "primary"} disabled={busy} autoFocus onClick={() => run(onClick).then(() => setAsking(false))}>Confirm</button>
          <button disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
        </span>
        <ErrorText error={error} />
      </span>
    );
  }
  return (
    <span className="action-button">
      <button className={className} disabled={busy} onClick={() => (confirmText ? setAsking(true) : run(onClick))}>{children}</button>
      <ErrorText error={error} />
    </span>
  );
}
