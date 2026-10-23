import { useState } from "react";
import { api, fmtMoney, label } from "../../api";
import { DataTable, ErrorText, Loading, Money } from "../../components/ui";
import { canManage } from "../../components/records";
import type { ProjectInfo } from "../Project";
import { useAction, useApi } from "../../hooks";

const CURVES = ["linear", "front", "back", "s_curve"];

/** Cumulative forecast vs actual, as a small accessible SVG line chart. */
function Chart({ totals }: { totals: { month: string; cumulative_forecast: string; cumulative_actual: string }[] }) {
  const W = 640, H = 180, pad = 30;
  const max = Math.max(1, ...totals.map((t) => Number(t.cumulative_forecast)), ...totals.map((t) => Number(t.cumulative_actual)));
  const x = (i: number) => pad + (totals.length <= 1 ? 0 : (i * (W - 2 * pad)) / (totals.length - 1));
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  const line = (k: "cumulative_forecast" | "cumulative_actual") => totals.map((t, i) => `${x(i)},${y(Number(t[k]))}`).join(" ");
  const last = totals[totals.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cashflow-chart" role="img" aria-label={`Cumulative cost: forecast ${fmtMoney(last?.cumulative_forecast)}, actual to date ${fmtMoney(last?.cumulative_actual)}`}>
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#a1a1aa" />
      <polyline points={line("cumulative_forecast")} fill="none" stroke="#2563eb" strokeWidth={2} />
      <polyline points={line("cumulative_actual")} fill="none" stroke="#c2410c" strokeWidth={2} strokeDasharray="5 3" />
      {totals.map((t, i) => <text key={t.month} x={x(i)} y={H - 10} fontSize={10} textAnchor="middle" fill="#52525b">{t.month.slice(2)}</text>)}
    </svg>
  );
}

export function CashFlowSection({ projectId, manager }: { projectId: string; manager: boolean }) {
  const c = useApi(`/projects/${projectId}/cash-flow`);
  const [edit, setEdit] = useState<string | null>(null);
  const [form, setForm] = useState({ start: "", end: "", curve: "linear" });
  const { error, run } = useAction();
  if (c.error) return <ErrorText error={c.error} />;
  if (!c.data) return <Loading />;
  const d = c.data;
  return (
    <section className="card" aria-label="Cash flow">
      <h2>Cash flow <a className="button small" href={`/api/projects/${projectId}/cash-flow.csv`}>Export CSV</a></h2>
      <p className="muted small">Each cost code's estimate at completion is spread over its months (project dates unless set). Actuals are approved direct costs and approved subcontractor invoices. <span className="swatch" style={{ background: "#2563eb" }} /> forecast <span className="swatch" style={{ background: "#c2410c" }} /> actual (cumulative)</p>
      {d.totals.length > 0 && <Chart totals={d.totals} />}
      <DataTable rows={d.totals.map((t: any) => ({ ...t, id: t.month }))} empty="No budget yet." caption="Monthly cash flow" columns={[
        { label: "Month", render: (t: any) => t.month }, { label: "Forecast", render: (t: any) => <Money value={t.forecast} /> }, { label: "Actual", render: (t: any) => <Money value={t.actual} /> },
        { label: "Cumulative forecast", render: (t: any) => <Money value={t.cumulative_forecast} /> }, { label: "Cumulative actual", render: (t: any) => <Money value={t.cumulative_actual} /> },
      ]} />
      <h3>Spread by cost code</h3>
      <DataTable rows={d.rows.map((r: any) => ({ ...r, id: r.cost_code_id }))} caption="Spread by cost code" columns={[
        { label: "Cost code", render: (r: any) => `${r.cost_code} ${r.description}` },
        { label: "Estimate at completion", render: (r: any) => <Money value={r.eac} /> },
        { label: "Spread", render: (r: any) => edit === r.cost_code_id ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("PUT", `/projects/${projectId}/budget/lines/${r.cost_code_id}/spread`, form); setEdit(null); c.reload(); }); }}>
            <input type="month" aria-label={`Spread start for ${r.cost_code}`} required value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
            <input type="month" aria-label={`Spread end for ${r.cost_code}`} required value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            <select aria-label={`Curve for ${r.cost_code}`} value={form.curve} onChange={(e) => setForm({ ...form, curve: e.target.value })}>{CURVES.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select>
            <button type="submit">Save</button> <button type="button" className="link" onClick={() => setEdit(null)}>Cancel</button>
          </form>
        ) : <>{r.spread.start} – {r.spread.end} · {label(r.spread.curve)}{!r.spread.set && <span className="muted small"> (project dates)</span>}
            {manager && <> <button type="button" className="link" onClick={() => { setForm({ start: r.spread.start, end: r.spread.end, curve: r.spread.curve }); setEdit(r.cost_code_id); }}>Change</button></>}</> },
      ]} />
      <ErrorText error={error} />
    </section>
  );
}

export function CashFlowTool({ project }: { project: ProjectInfo }) {
  return <><h2 className="tool-title">Cash flow</h2><CashFlowSection projectId={project.id} manager={canManage(project.myRole)} /></>;
}
