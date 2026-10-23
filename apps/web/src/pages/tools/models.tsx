import { fmtBytes, fmtDateTime, upload } from "../../api";
import { canWrite } from "../../components/records";
import { Creator, DataTable, ErrorText, Form, Loading, PageHead } from "../../components/ui";
import { useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

const summary = (counts: Record<string, number>) =>
  Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ") || "—";

export function ModelsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/models`);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Models (BIM)</h2>
        {canWrite(project.myRole) && (
          <Creator label="Upload model">
            {(close) => (
              <Form ariaLabel="Upload model" submitLabel="Upload" onCancel={close}
                fields={[
                  { name: "name", label: "Model name (same name adds a version)", required: true, placeholder: "Architecture" },
                  { name: "discipline", label: "Discipline", placeholder: "Architectural" },
                  { name: "note", label: "What changed" },
                  { name: "file", label: "IFC file", type: "file", accept: ".ifc", required: true, full: true },
                ]}
                onSubmit={async (v) => { await upload(`/projects/${project.id}/models`, { name: v.name, discipline: v.discipline, note: v.note }, v.file); close(); list.reload(); }} />
            )}
          </Creator>
        )}
      </div>
      <p className="muted small">IFC files are versioned and summarised by element type so coordination changes are visible at a glance. Open them in your BIM viewer of choice.</p>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(m) => `/models/${m.id}`} empty="No models uploaded yet." caption="Models" columns={[
          { label: "Model", render: (m) => m.name },
          { label: "Discipline", render: (m) => m.discipline },
          { label: "Version", render: (m) => m.version },
          { label: "Schema", render: (m) => m.ifc_schema ?? "—" },
          { label: "Elements", render: (m) => summary(m.element_counts) },
          { label: "Updated", render: (m) => `${fmtDateTime(m.created_at)} · ${m.uploaded_by_name ?? ""}` },
        ]} />
      </section>
    </>
  );
}

export function ModelPage({ id }: { id: string }) {
  const r = useApi(`/models/${id}`);
  const m = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!m) return <Loading />;
  return (
    <>
      <PageHead back={{ to: `/projects/${m.project_id}/models`, label: "Models" }} title={m.name} sub={`${m.discipline} · ${m.versions.length} version(s)`} />
      {m.versions.map((v: any) => (
        <section className="card" key={v.id} aria-label={`Version ${v.version}`}>
          <h2>Version {v.version} <span className="muted small">{v.ifc_schema ?? "unknown schema"} · {fmtBytes(v.size)} · {fmtDateTime(v.created_at)} · {v.uploaded_by_name ?? ""}</span></h2>
          {v.note && <p>{v.note}</p>}
          <p><a className="button" href={`/api/files/${v.file_id}/download`}>Download IFC</a></p>
          <DataTable rows={v.changes} empty="No recognised building elements." caption={`Elements in version ${v.version}`} columns={[
            { label: "Element", render: (c: any) => c.type },
            { label: "Count", render: (c: any) => c.count },
            { label: "Change", render: (c: any) => c.change === 0 ? "—" : <span className={c.change < 0 ? "overdue" : ""}>{c.change > 0 ? `+${c.change}` : c.change}</span> },
          ]} />
        </section>
      ))}
    </>
  );
}
