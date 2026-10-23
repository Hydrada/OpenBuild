import { useState } from "react";
import { api } from "../api";
import { ActionButton, DataTable, ErrorText, Loading } from "../components/ui";
import { useAction, useApi } from "../hooks";

const LEVELS = [
  { value: "none", label: "None" }, { value: "read", label: "Read only" },
  { value: "standard", label: "Standard (role)" }, { value: "admin", label: "Admin" },
];

/** Company settings: templates that set each project tool to none / read only / standard / admin. */
export function PermissionTemplatesSection({ orgId }: { orgId: string }) {
  const tools = useApi<{ key: string; label: string }[]>("/permission-tools");
  const list = useApi<any[]>(`/orgs/${orgId}/permission-templates`);
  const [editing, setEditing] = useState<{ id: string | null; name: string; levels: Record<string, string> } | null>(null);
  const { error, run } = useAction();
  if (!tools.data) return <Loading />;
  const save = () => run(async () => {
    const levels = Object.fromEntries(Object.entries(editing!.levels).filter(([, v]) => v !== "standard"));
    if (editing!.id) await api("PATCH", `/permission-templates/${editing!.id}`, { name: editing!.name, levels });
    else await api("POST", `/orgs/${orgId}/permission-templates`, { name: editing!.name, levels });
    setEditing(null); list.reload();
  });
  return (
    <section className="card" aria-label="Permission templates">
      <h2>Permission templates</h2>
      <p className="muted small">Assign a template to a project member to narrow or widen their access tool by tool. Tools left on "Standard" follow their project role. Company admins are never restricted.</p>
      <DataTable rows={list.data} empty="No templates yet." caption="Permission templates" columns={[
        { label: "Template", render: (t) => t.name },
        { label: "Changes", render: (t) => Object.entries(t.levels).map(([k, v]) => `${tools.data!.find((x) => x.key === k)?.label ?? k}: ${v}`).join("; ") || "None" },
        { label: "Used by", render: (t) => `${t.members} member(s)` },
        { label: "", render: (t) => <span className="row-actions">
          <button type="button" className="link" onClick={() => setEditing({ id: t.id, name: t.name, levels: { ...t.levels } })}>Edit</button>
          <ActionButton className="link danger" confirm={`Delete the template "${t.name}"? Members using it go back to their role.`} onClick={async () => { await api("DELETE", `/permission-templates/${t.id}`); list.reload(); }}>Delete</ActionButton>
        </span> },
      ]} />
      {!editing && <button type="button" onClick={() => setEditing({ id: null, name: "", levels: {} })}>New template</button>}
      {editing && (
        <form className="card" aria-label="Edit permission template" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label>Template name <input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Tool levels</caption>
              <thead><tr><th scope="col">Tool</th><th scope="col">Level</th></tr></thead>
              <tbody>
                {tools.data.map((t) => (
                  <tr key={t.key}>
                    <td>{t.label}</td>
                    <td><select aria-label={`Level for ${t.label}`} value={editing.levels[t.key] ?? "standard"} onChange={(e) => setEditing({ ...editing, levels: { ...editing.levels, [t.key]: e.target.value } })}>
                      {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </select></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorText error={error} />
          <div className="actions"><button type="button" onClick={() => setEditing(null)}>Cancel</button><button className="primary" type="submit">Save template</button></div>
        </form>
      )}
    </section>
  );
}
