import { useEffect, useState } from "react";
import { api, label } from "../api";
import { ActionButton, Badge, DataTable, ErrorText, Loading, Money, PageHead } from "../components/ui";
import { useAction, useApi } from "../hooks";

interface DatasetInfo { key: string; label: string; statuses: string[]; canFilterAssignee: boolean; columns: { key: string; label: string; type: string }[] }
interface Config { columns: string[]; statuses: string[]; from?: string | null; to?: string | null; text?: string | null; groupBy?: string | null; sumColumn?: string | null; sort?: string | null; sortDesc?: boolean }
interface Result { columns: { key: string; label: string; type: string }[]; rows: Record<string, unknown>[]; groups: { key: string; count: number; total: string | null }[] | null; total: string | null; truncated: boolean }

function Cell({ v, type }: { v: unknown; type: string }) {
  if (v === null || v === undefined || v === "") return <>—</>;
  if (type === "money") return <Money value={String(v)} />;
  if (type === "status") return <Badge value={String(v)} />;
  if (type === "boolean") return <>{v ? "Yes" : "No"}</>;
  return <>{String(v)}</>;
}

export function ResultTable({ result }: { result: Result }) {
  return (
    <>
      {result.groups && (
        <DataTable rows={result.groups.map((g) => ({ ...g, id: g.key }))} caption="Summary by group" columns={[
          { label: "Group", render: (g) => label(g.key) },
          { label: "Count", render: (g) => g.count },
          ...(result.total !== null ? [{ label: "Total", render: (g: any) => <Money value={g.total} /> }] : []),
        ]} />
      )}
      <p className="muted small">{result.rows.length} row(s){result.total !== null && <> · total <strong><Money value={result.total} /></strong></>}{result.truncated && " · showing the first 5,000"}</p>
      <DataTable rows={result.rows.map((r, i) => ({ ...r, id: String(i) }))} empty="No rows match." caption="Report results" columns={result.columns.map((c) => ({ label: c.label, render: (r: any) => <Cell v={r[c.key]} type={c.type} /> }))} />
    </>
  );
}

export function ReportsPage({ orgId }: { orgId: string }) {
  const datasets = useApi<DatasetInfo[]>("/reports/datasets");
  const projects = useApi<any[]>(`/orgs/${orgId}/projects`);
  const saved = useApi<any[]>(`/orgs/${orgId}/reports`);
  const [dataset, setDataset] = useState("rfis");
  const [projectId, setProjectId] = useState("");
  const [cfg, setCfg] = useState<Config>({ columns: [], statuses: [] });
  const [result, setResult] = useState<Result | null>(null);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { error, run, busy } = useAction();
  const ds = datasets.data?.find((d) => d.key === dataset);

  useEffect(() => {
    if (ds) { setCfg({ columns: ds.columns.slice(0, 5).map((c) => c.key), statuses: [] }); setResult(null); }
  }, [ds?.key]);

  if (!datasets.data) return <Loading />;
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const numeric = ds?.columns.filter((c) => c.type === "number" || c.type === "money") ?? [];
  const runNow = () => run(async () => setResult(await api("POST", `/orgs/${orgId}/reports/run`, { dataset, projectId: projectId || null, config: cfg })));

  return (
    <>
      <PageHead title="Reports" sub="Build a report over one project or every project you can see, save it, and export it to CSV." />
      <section className="card" aria-label="Saved reports">
        <h2>Saved reports</h2>
        <DataTable rows={saved.data} href={(r) => `/reports/${r.id}`} empty="No saved reports yet." caption="Saved reports" columns={[
          { label: "Name", render: (r) => r.name },
          { label: "Data", render: (r) => datasets.data!.find((d) => d.key === r.dataset)?.label ?? r.dataset },
          { label: "Scope", render: (r) => r.project_name ?? "All projects" },
          { label: "Shared", render: (r) => (r.shared ? "Shared" : "Only me") },
          { label: "By", render: (r) => r.created_by_name ?? "—" },
        ]} />
      </section>
      <section className="card" aria-label="Report builder">
        <h2>New report</h2>
        <div className="row">
          <label>Data <select value={dataset} onChange={(e) => setDataset(e.target.value)}>{datasets.data.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}</select></label>
          <label>Scope <select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">All projects</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>From <input type="date" value={cfg.from ?? ""} onChange={(e) => setCfg({ ...cfg, from: e.target.value || null })} /></label>
          <label>To <input type="date" value={cfg.to ?? ""} onChange={(e) => setCfg({ ...cfg, to: e.target.value || null })} /></label>
          <label>Contains <input value={cfg.text ?? ""} onChange={(e) => setCfg({ ...cfg, text: e.target.value || null })} /></label>
        </div>
        {ds && (
          <>
            <fieldset className="checks">
              <legend>Columns</legend>
              {ds.columns.map((c) => <label key={c.key} className="check"><input type="checkbox" checked={cfg.columns.includes(c.key)} onChange={() => setCfg({ ...cfg, columns: toggle(cfg.columns, c.key) })} /> {c.label}</label>)}
            </fieldset>
            <fieldset className="checks">
              <legend>Status (none = all)</legend>
              {ds.statuses.map((s) => <label key={s} className="check"><input type="checkbox" checked={cfg.statuses.includes(s)} onChange={() => setCfg({ ...cfg, statuses: toggle(cfg.statuses, s) })} /> {label(s)}</label>)}
            </fieldset>
            <div className="row">
              <label>Group by <select value={cfg.groupBy ?? ""} onChange={(e) => setCfg({ ...cfg, groupBy: e.target.value || null })}><option value="">No grouping</option>{ds.columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
              <label>Total <select value={cfg.sumColumn ?? ""} onChange={(e) => setCfg({ ...cfg, sumColumn: e.target.value || null })}><option value="">Nothing</option>{numeric.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
              <label>Sort by <select value={cfg.sort ?? ""} onChange={(e) => setCfg({ ...cfg, sort: e.target.value || null })}><option value="">Newest first</option>{ds.columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
              <label className="check"><input type="checkbox" checked={!!cfg.sortDesc} onChange={(e) => setCfg({ ...cfg, sortDesc: e.target.checked })} /> Descending</label>
              <button className="primary" type="button" disabled={busy || !cfg.columns.length} onClick={runNow}>Run report</button>
            </div>
          </>
        )}
        <ErrorText error={error} />
        {result && (
          <>
            <ResultTable result={result} />
            <form className="row" onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api("POST", `/orgs/${orgId}/reports`, { name, dataset, projectId: projectId || null, config: cfg, shared });
                setMsg(`Saved "${name}"`); setName(""); saved.reload();
              });
            }}>
              <label>Report name <input required value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label className="check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with the company</label>
              <button type="submit">Save report</button>
              {msg && <span className="muted small" role="status">{msg}</span>}
            </form>
          </>
        )}
      </section>
    </>
  );
}

export function SavedReportPage({ id }: { id: string }) {
  const r = useApi(`/reports/${id}`);
  if (r.error) return <ErrorText error={r.error} />;
  if (!r.data) return <Loading />;
  const rep = r.data;
  return (
    <>
      <PageHead back={{ to: "/reports", label: "Reports" }} title={rep.name} sub={rep.project_id ? "One project" : "All projects you can see"}
        actions={<>
          <a className="button" href={`/api/reports/${id}/csv`}>Download CSV</a>
          {rep.mine && <ActionButton className="link danger" confirm={`Delete the report "${rep.name}"?`} onClick={async () => { await api("DELETE", `/reports/${id}`); history.back(); }}>Delete</ActionButton>}
        </>} />
      <section className="card"><ResultTable result={rep.result} /></section>
    </>
  );
}
