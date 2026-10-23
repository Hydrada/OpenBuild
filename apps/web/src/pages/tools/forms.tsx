import { useState } from "react";
import { api, fmtDateTime, label } from "../../api";
import { canWrite } from "../../components/records";
import { Badge, Creator, DataTable, ErrorText, Form, Loading, PageHead } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import { navigate } from "../../router";
import type { ProjectInfo } from "../Project";

const TYPES = ["text", "textarea", "number", "date", "checkbox", "select", "signature"];
interface Field { key: string; label: string; type: string; required: boolean; options?: string[] }

/** Company settings: build form templates field by field. */
export function FormTemplatesSection({ orgId }: { orgId: string }) {
  const list = useApi<any[]>(`/orgs/${orgId}/form-templates`);
  const [name, setName] = useState("");
  const [fields, setFields] = useState<(Field & { optionsText?: string })[]>([]);
  const { error, run } = useAction();
  const set = (i: number, k: string, v: unknown) => setFields(fields.map((f, j) => (j === i ? { ...f, [k]: v } : f)));
  const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 40) || "field";
  return (
    <section className="card" aria-label="Form templates">
      <h2>Form templates</h2>
      <DataTable rows={list.data} empty="No form templates yet." caption="Form templates" columns={[
        { label: "Form", render: (t) => t.name }, { label: "Fields", render: (t) => t.fields.length },
        { label: "", render: (t) => <button type="button" className="link" onClick={() => run(async () => { await api("PATCH", `/form-templates/${t.id}`, { archived: !t.archived }); list.reload(); })}>{t.archived ? "Restore" : "Archive"}</button> },
      ]} />
      <form className="card" aria-label="New form template" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const used = new Set<string>();
          const out = fields.map((f) => {
            let k = keyOf(f.label), n = 2;
            while (used.has(k)) k = `${keyOf(f.label)}_${n++}`;
            used.add(k);
            return { key: k, label: f.label, type: f.type, required: f.required, ...(f.type === "select" ? { options: (f.optionsText ?? "").split(",").map((o) => o.trim()).filter(Boolean) } : {}) };
          });
          await api("POST", `/orgs/${orgId}/form-templates`, { name, fields: out });
          setName(""); setFields([]); list.reload();
        });
      }}>
        <label>Form name <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Hot work permit" /></label>
        {fields.map((f, i) => (
          <div className="row" key={i}>
            <input aria-label={`Field ${i + 1} label`} required value={f.label} onChange={(e) => set(i, "label", e.target.value)} placeholder="Question" />
            <select aria-label={`Field ${i + 1} type`} value={f.type} onChange={(e) => set(i, "type", e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select>
            {f.type === "select" && <input aria-label={`Field ${i + 1} options`} value={f.optionsText ?? ""} onChange={(e) => set(i, "optionsText", e.target.value)} placeholder="Option A, Option B" required />}
            <label className="check"><input type="checkbox" checked={f.required} onChange={(e) => set(i, "required", e.target.checked)} /> Required</label>
            <button type="button" className="link danger" onClick={() => setFields(fields.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => setFields([...fields, { key: "", label: "", type: "text", required: false }])}>Add question</button>
        <ErrorText error={error} />
        <div className="actions"><button className="primary" type="submit" disabled={!fields.length}>Save form template</button></div>
      </form>
    </section>
  );
}

export function FormsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/forms`);
  const templates = useApi<any[]>(`/orgs/${project.org_id}/form-templates`);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Forms</h2>
        {canWrite(project.myRole) && (
          <Creator label="Start form">
            {(close) => (
              <Form ariaLabel="Start form" submitLabel="Start" onCancel={close}
                fields={[
                  { name: "templateId", label: "Form", type: "select", required: true, options: (templates.data ?? []).filter((t) => !t.archived).map((t) => ({ value: t.id, label: t.name })) },
                  { name: "title", label: "Title (optional)" },
                ]}
                onSubmit={async (v) => { const f = await api("POST", `/projects/${project.id}/forms`, { templateId: v.templateId, title: v.title || undefined }); navigate(`/forms/${f.id}`); }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(f) => `/forms/${f.id}`} empty="No forms yet. Company admins build form templates in Settings." caption="Forms" columns={[
          { label: "#", render: (f) => f.number }, { label: "Title", render: (f) => f.title }, { label: "Form", render: (f) => f.template_name },
          { label: "Started", render: (f) => `${fmtDateTime(f.created_at)} · ${f.created_by_name ?? "—"}` }, { label: "Status", render: (f) => <Badge value={f.status} /> },
        ]} />
      </section>
    </>
  );
}

export function FormPage({ id }: { id: string }) {
  const r = useApi(`/forms/${id}`);
  const [answers, setAnswers] = useState<Record<string, any> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { error, run } = useAction();
  const f = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!f) return <Loading />;
  const a = answers ?? f.answers;
  const editable = canWrite(f.myRole) && f.status === "draft";
  const set = (k: string, v: unknown) => setAnswers({ ...a, [k]: v });
  const save = (submit: boolean) => run(async () => { await api("PUT", `/forms/${id}`, { answers: a, submit }); setMsg(submit ? "Submitted" : "Saved"); setAnswers(null); r.reload(); });
  return (
    <>
      <PageHead pdf={`/forms/${f.id}/pdf`} back={{ to: `/projects/${f.project_id}/forms`, label: "Forms" }} title={<>Form #{f.number}: {f.title} <Badge value={f.status} /></>}
        sub={f.status === "submitted" ? `Submitted by ${f.submitted_by_name ?? "—"} ${fmtDateTime(f.submitted_at)}` : `Started by ${f.created_by_name ?? "—"}`} />
      <form className="card form" aria-label="Form answers" onSubmit={(e) => { e.preventDefault(); save(true); }}>
        {f.fields.map((x: Field) => {
          const v = a[x.key];
          const lbl = `${x.label}${x.required ? " *" : ""}`;
          if (!editable) return <div key={x.key}><strong>{x.label}</strong><div>{v === undefined || v === null ? "—" : x.type === "checkbox" ? (v ? "Yes" : "No") : x.type === "signature" ? `Signed: ${v.name} (${fmtDateTime(v.at)})` : String(v)}</div></div>;
          switch (x.type) {
            case "textarea": return <label key={x.key}>{lbl}<textarea value={v ?? ""} onChange={(e) => set(x.key, e.target.value)} /></label>;
            case "number": return <label key={x.key}>{lbl}<input inputMode="decimal" value={v ?? ""} onChange={(e) => set(x.key, e.target.value)} /></label>;
            case "date": return <label key={x.key}>{lbl}<input type="date" value={v ?? ""} onChange={(e) => set(x.key, e.target.value)} /></label>;
            case "checkbox": return <label key={x.key} className="check"><input type="checkbox" checked={!!v} onChange={(e) => set(x.key, e.target.checked)} /> {lbl}</label>;
            case "select": return <label key={x.key}>{lbl}<select value={v ?? ""} onChange={(e) => set(x.key, e.target.value)}><option value="">Choose…</option>{x.options!.map((o) => <option key={o}>{o}</option>)}</select></label>;
            case "signature": return <label key={x.key}>{lbl} (type your full name to sign)<input value={v?.name ?? ""} onChange={(e) => set(x.key, { name: e.target.value })} /></label>;
            default: return <label key={x.key}>{lbl}<input value={v ?? ""} onChange={(e) => set(x.key, e.target.value)} /></label>;
          }
        })}
        <ErrorText error={error} />
        {msg && <p className="muted small" role="status">{msg}</p>}
        {editable && <div className="actions"><button type="button" onClick={() => save(false)}>Save draft</button><button className="primary" type="submit">Submit form</button></div>}
      </form>
    </>
  );
}
