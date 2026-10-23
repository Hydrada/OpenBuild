import { useState } from "react";
import { api, label } from "../../api";
import { canManage, canWrite } from "../../components/records";
import { ActionButton, Badge, Creator, DataTable, ErrorText, Form, KeyValues, Loading, Money, PageHead } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import { navigate } from "../../router";
import type { ProjectInfo } from "../Project";

const CATS = ["labor", "material", "equipment", "subcontract", "other"];
interface Row { costCodeId: string; description: string; category: string; quantity: string; unit: string; unitCost: string }

export function EstimatesTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/estimates`);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Estimating</h2>
        {canWrite(project.myRole) && (
          <Creator label="New estimate">
            {(close) => (
              <Form ariaLabel="New estimate" submitLabel="Create estimate" onCancel={close} initial={{ overheadPct: "10", contingencyPct: "5", profitPct: "8", bondPct: "1" }}
                fields={[
                  { name: "name", label: "Name", required: true, placeholder: "GMP v1" },
                  { name: "overheadPct", label: "Overhead %", type: "number", step: "0.001" },
                  { name: "contingencyPct", label: "Contingency %", type: "number", step: "0.001" },
                  { name: "profitPct", label: "Profit %", type: "number", step: "0.001" },
                  { name: "bondPct", label: "Bond %", type: "number", step: "0.001" },
                ]}
                onSubmit={async (v) => { const e = await api("POST", `/projects/${project.id}/estimates`, { name: v.name, overheadPct: String(v.overheadPct || 0), contingencyPct: String(v.contingencyPct || 0), profitPct: String(v.profitPct || 0), bondPct: String(v.bondPct || 0) }); navigate(`/estimates/${e.id}`); }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(e) => `/estimates/${e.id}`} empty="No estimates yet." caption="Estimates" columns={[
          { label: "Estimate", render: (e) => e.name }, { label: "Lines", render: (e) => e.lines },
          { label: "Direct cost", render: (e) => <Money value={e.direct} /> }, { label: "Total", render: (e) => <Money value={e.total} /> },
          { label: "Status", render: (e) => <Badge value={e.status} /> },
        ]} />
      </section>
    </>
  );
}

export function EstimatePage({ id }: { id: string }) {
  const r = useApi(`/estimates/${id}`);
  const e = r.data;
  const codes = useApi<any[]>(e ? `/projects/${e.project_id}/cost-codes` : null);
  const proj = useApi<any>(e ? `/projects/${e.project_id}` : null);
  const catalog = useApi<any[]>(proj.data ? `/orgs/${proj.data.org_id}/cost-catalog` : null);
  const takeoff = useApi<any[]>(e ? `/projects/${e.project_id}/takeoff` : null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const { busy, error, run } = useAction();
  if (r.error) return <ErrorText error={r.error} />;
  if (!e) return <Loading />;
  const editable = canWrite(e.myRole) && e.status === "draft";
  const cur: Row[] = rows ?? e.lines.map((l: any) => ({ costCodeId: l.cost_code_id ?? "", description: l.description, category: l.category, quantity: l.quantity, unit: l.unit ?? "", unitCost: l.unit_cost }));
  const set = (i: number, k: keyof Row, v: string) => setRows(cur.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const t = e.totals;
  return (
    <>
      <PageHead back={{ to: `/projects/${e.project_id}/estimates`, label: "Estimating" }} title={<>{e.name} <Badge value={e.status} /></>}
        sub={`Overhead ${Number(e.overhead_pct)}% · contingency ${Number(e.contingency_pct)}% · profit ${Number(e.profit_pct)}% · bond ${Number(e.bond_pct)}%`}
        actions={<>
          <a className="button" href={`/api/estimates/${id}/csv`}>Export CSV</a>
          {canManage(e.myRole) && e.status === "draft" && <ActionButton className="primary" confirm="Write each cost code's total into the original budget and finalize this estimate?" onClick={async () => { await api("POST", `/estimates/${id}/send-to-budget`); r.reload(); }}>Send to budget</ActionButton>}
        </>} />
      <section className="card summary" aria-label="Estimate summary">
        <KeyValues items={[["Direct cost", <Money value={t.direct} />], ["Overhead", <Money value={t.overhead} />], ["Contingency", <Money value={t.contingency} />], ["Profit", <Money value={t.profit} />], ["Bond", <Money value={t.bond} />], ["Total", <strong><Money value={t.total} /></strong>]]} />
      </section>
      <section className="card" aria-label="Estimate lines">
        <h2>Lines</h2>
        <div className="table-wrap">
          <table className="table lines">
            <caption className="sr-only">Estimate lines</caption>
            <thead><tr><th>Cost code</th><th>Description</th><th>Type</th><th>Qty</th><th>Unit</th><th>Unit cost</th><th className="num">Amount</th>{editable && <th />}</tr></thead>
            <tbody>
              {cur.map((l, i) => editable ? (
                <tr key={i}>
                  <td><select aria-label={`Cost code line ${i + 1}`} value={l.costCodeId} onChange={(ev) => set(i, "costCodeId", ev.target.value)}><option value="">—</option>{(codes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} {c.description}</option>)}</select></td>
                  <td><input aria-label={`Description line ${i + 1}`} required value={l.description} onChange={(ev) => set(i, "description", ev.target.value)} /></td>
                  <td><select aria-label={`Type line ${i + 1}`} value={l.category} onChange={(ev) => set(i, "category", ev.target.value)}>{CATS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></td>
                  <td><input aria-label={`Quantity line ${i + 1}`} inputMode="decimal" size={7} value={l.quantity} onChange={(ev) => set(i, "quantity", ev.target.value)} /></td>
                  <td><input aria-label={`Unit line ${i + 1}`} size={4} value={l.unit} onChange={(ev) => set(i, "unit", ev.target.value)} /></td>
                  <td><input aria-label={`Unit cost line ${i + 1}`} inputMode="decimal" size={8} value={l.unitCost} onChange={(ev) => set(i, "unitCost", ev.target.value)} /></td>
                  <td className="num">{e.lines[i] && !rows ? <Money value={e.lines[i].amount} /> : "—"}</td>
                  <td><button type="button" className="link danger" onClick={() => setRows(cur.filter((_, j) => j !== i))}>Remove</button></td>
                </tr>
              ) : (
                <tr key={i}><td>{e.lines[i].cost_code ?? "—"}</td><td>{l.description}</td><td>{label(l.category)}</td><td>{l.quantity}</td><td>{l.unit}</td><td><Money value={l.unitCost} /></td><td className="num"><Money value={e.lines[i].amount} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="actions left wrap">
            <button type="button" onClick={() => setRows([...cur, { costCodeId: "", description: "", category: "material", quantity: "1", unit: "", unitCost: "0" }])}>Add line</button>
            {(catalog.data ?? []).length > 0 && (
              <select aria-label="Add from cost catalog" value="" onChange={(ev) => {
                const it = catalog.data!.find((c) => c.id === ev.target.value);
                if (it) setRows([...cur, { costCodeId: "", description: it.name, category: it.category, quantity: "1", unit: it.unit, unitCost: it.unit_cost }]);
              }}>
                <option value="">Add from cost catalog…</option>{catalog.data!.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.unit} @ {c.unit_cost})</option>)}
              </select>
            )}
            {(takeoff.data ?? []).length > 0 && (
              <select aria-label="Add from takeoff" value="" onChange={(ev) => {
                const m = takeoff.data!.find((t) => t.id === ev.target.value);
                if (m) setRows([...cur, { costCodeId: m.cost_code_id ?? "", description: `${m.name} (${m.sheet})`, category: "material", quantity: String(Number(m.quantity)), unit: m.unit, unitCost: "0" }]);
              }}>
                <option value="">Add from takeoff…</option>{takeoff.data!.map((t) => <option key={t.id} value={t.id}>{t.sheet}: {t.name} — {Number(t.quantity)} {t.unit}</option>)}
              </select>
            )}
            <button className="primary" type="button" disabled={busy || !rows} onClick={() => run(async () => {
              await api("PUT", `/estimates/${id}`, { lines: cur.map((l) => ({ costCodeId: l.costCodeId || null, description: l.description, category: l.category, quantity: l.quantity, unit: l.unit || null, unitCost: l.unitCost.replace(/,/g, "") })) });
              setRows(null); r.reload();
            })}>Save lines</button>
          </div>
        )}
        <ErrorText error={error} />
      </section>
      <section className="card" aria-label="By cost code">
        <h2>By cost code</h2>
        <DataTable rows={e.byCostCode.map((g: any) => ({ ...g, id: g.cost_code }))} caption="Totals by cost code" columns={[
          { label: "Cost code", render: (g: any) => `${g.cost_code} ${g.description}` }, { label: "Direct", render: (g: any) => <Money value={g.direct} /> }, { label: "With markup", render: (g: any) => <Money value={g.with_markup} /> },
        ]} />
      </section>
    </>
  );
}

/** Company settings: unit-cost catalog used when estimating. */
export function CostCatalogSection({ orgId }: { orgId: string }) {
  const list = useApi<any[]>(`/orgs/${orgId}/cost-catalog`);
  return (
    <section className="card" aria-label="Cost catalog">
      <h2>Cost catalog</h2>
      <Form ariaLabel="Add catalog item" submitLabel="Add item" resetOnSuccess className="flat" initial={{ category: "material" }}
        fields={[
          { name: "name", label: "Item", required: true }, { name: "category", label: "Cost type", type: "select", required: true, options: CATS.map((c) => ({ value: c, label: label(c) })) },
          { name: "unit", label: "Unit", required: true, placeholder: "CY" }, { name: "unitCost", label: "Unit cost", type: "money", required: true },
        ]}
        onSubmit={async (v) => { await api("POST", `/orgs/${orgId}/cost-catalog`, { name: v.name, category: v.category, unit: v.unit, unitCost: String(v.unitCost).replace(/,/g, "") }); list.reload(); }} />
      <DataTable rows={list.data} empty="No catalog items." caption="Cost catalog" columns={[
        { label: "Item", render: (c) => c.name }, { label: "Type", render: (c) => label(c.category) }, { label: "Unit", render: (c) => c.unit }, { label: "Unit cost", render: (c) => <Money value={c.unit_cost} /> },
        { label: "", render: (c) => <ActionButton className="link danger" onClick={async () => { await api("DELETE", `/cost-catalog/${c.id}`); list.reload(); }}>Delete</ActionButton> },
      ]} />
    </section>
  );
}
