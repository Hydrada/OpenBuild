import { lazy, Suspense, useState } from "react";
import { api, fmtBytes, fmtDateTime, upload } from "../../api";
import { canWrite } from "../../components/records";
import { Creator, DataTable, ErrorText, Form, Loading, PageHead } from "../../components/ui";
import { useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

// The IFC engine and 3D renderer load only when a model is opened.
const ModelViewer = lazy(() => import("../../components/ModelViewer"));

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
      <p className="muted small">IFC files are versioned, summarised by element type and viewable in 3D. Run clash detection between two models below.</p>
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
      {(list.data?.length ?? 0) >= 2 && <ClashRunner projectId={project.id} models={list.data!} />}
    </>
  );
}

function ClashRunner({ projectId, models }: { projectId: string; models: any[] }) {
  const runs = useApi<any[]>(`/projects/${projectId}/clashes`);
  const options = models.map((m) => ({ value: m.id, label: `${m.name} v${m.version}` }));
  return (
    <section className="card" aria-label="Clash detection">
      <h2>Clash detection</h2>
      <Form ariaLabel="Run clash detection" submitLabel="Run clash detection" className="flat" initial={{ toleranceMm: "10" }}
        fields={[
          { name: "modelAId", label: "Model A", type: "select", required: true, options },
          { name: "modelBId", label: "Model B", type: "select", required: true, options },
          { name: "toleranceMm", label: "Tolerance (mm)", type: "number", min: "0", step: "1" },
        ]}
        onSubmit={async (v) => { await api("POST", `/projects/${projectId}/clashes`, { modelAId: v.modelAId, modelBId: v.modelBId, toleranceMm: Number(v.toleranceMm) || 0 }); runs.reload(); }} />
      {runs.data?.map((r) => (
        <details key={r.id} open={r === runs.data![0]}>
          <summary><strong>{r.model_a} × {r.model_b}</strong> — {r.clash_count} clash(es) <span className="muted small">· {r.run_by} · {fmtDateTime(r.created_at)} · tolerance {Number(r.tolerance_m) * 1000} mm</span></summary>
          <DataTable rows={r.results.map((c: any, i: number) => ({ ...c, id: String(i) }))} empty="No clashes." caption="Clashes" columns={[
            { label: "Element A", render: (c: any) => `${c.a.name ?? c.a.id} (${c.a.type})` },
            { label: "Element B", render: (c: any) => `${c.b.name ?? c.b.id} (${c.b.type})` },
            { label: "Overlap (m)", render: (c: any) => c.overlapM.join(" × ") },
            { label: "Check", render: (c: any) => c.exact ? "Geometry" : "Bounding box" },
          ]} />
        </details>
      ))}
    </section>
  );
}

export function ModelPage({ id }: { id: string }) {
  const r = useApi(`/models/${id}`);
  const m = r.data;
  const [show, setShow] = useState<string | null>(null);
  const clashes = useApi<any[]>(m ? `/projects/${m.project_id}/clashes` : null);
  const clashIds = (clashes.data ?? []).slice(0, 1).flatMap((run) => run.results.flatMap((c: any) => [c.a.id, c.b.id]));
  if (r.error) return <ErrorText error={r.error} />;
  if (!m) return <Loading />;
  return (
    <>
      <PageHead back={{ to: `/projects/${m.project_id}/models`, label: "Models" }} title={m.name} sub={`${m.discipline} · ${m.versions.length} version(s)`} />
      {m.versions.map((v: any) => (
        <section className="card" key={v.id} aria-label={`Version ${v.version}`}>
          <h2>Version {v.version} <span className="muted small">{v.ifc_schema ?? "unknown schema"} · {fmtBytes(v.size)} · {fmtDateTime(v.created_at)} · {v.uploaded_by_name ?? ""}</span></h2>
          {v.note && <p>{v.note}</p>}
          <p className="actions left">
            <button className="primary" onClick={() => setShow(show === v.id ? null : v.id)}>{show === v.id ? "Hide 3D view" : "View in 3D"}</button>
            <a className="button" href={`/api/files/${v.file_id}/download`}>Download IFC</a>
          </p>
          {show === v.id && (
            <Suspense fallback={<Loading />}>
              <ModelViewer fileUrl={`/api/files/${v.file_id}/download`} highlight={clashIds} />
              {clashIds.length > 0 && <p className="muted small">Elements in the latest clash run are shown in red.</p>}
            </Suspense>
          )}
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
