import { useState } from "react";
import { api, fmtDate, label, today } from "../../api";
import { Approvals, Comments, canManage, canWrite, useMemberOptions } from "../../components/records";
import { ActionButton, Badge, Creator, DataTable, Empty, ErrorText, Form, KeyValues, Link, Loading, Money, PageHead } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

interface CostCode { id: string; code: string; description: string }
interface Line { costCodeId: string; description: string; amount: string }

function useCostCodes(projectId: string) {
  return useApi<CostCode[]>(`/projects/${projectId}/cost-codes`);
}

/** Editable list of cost-coded amount lines. */
function LinesEditor({ codes, lines, onChange, amountLabel = "Amount", allowNegative }: { codes: CostCode[]; lines: Line[]; onChange: (l: Line[]) => void; amountLabel?: string; allowNegative?: boolean }) {
  const set = (i: number, k: keyof Line, v: string) => onChange(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <div className="span-all">
      <div className="table-wrap">
        <table className="table lines">
          <thead><tr><th>Cost code</th><th>Description</th><th>{amountLabel}</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select aria-label={`Cost code line ${i + 1}`} required value={l.costCodeId} onChange={(e) => set(i, "costCodeId", e.target.value)}>
                    <option value="">Choose…</option>{codes.map((c) => <option key={c.id} value={c.id}>{c.code} {c.description}</option>)}
                  </select>
                </td>
                <td><input aria-label={`Description line ${i + 1}`} required value={l.description} onChange={(e) => set(i, "description", e.target.value)} /></td>
                <td><input aria-label={`${amountLabel} line ${i + 1}`} required inputMode="decimal" pattern={allowNegative ? "-?[0-9,]*(\\.[0-9]{0,2})?" : "[0-9,]*(\\.[0-9]{0,2})?"} value={l.amount} onChange={(e) => set(i, "amount", e.target.value)} /></td>
                <td><button type="button" className="link danger" onClick={() => onChange(lines.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => onChange([...lines, { costCodeId: "", description: "", amount: "" }])}>Add line</button>
    </div>
  );
}

// ---------------- Budget ----------------

export function BudgetTool({ project }: { project: ProjectInfo }) {
  const budget = useApi(`/projects/${project.id}/budget`);
  const codes = useCostCodes(project.id);
  const manager = canManage(project.myRole);
  const { error, run } = useAction();
  const [edit, setEdit] = useState<Record<string, { original?: string; forecast?: string }>>({});
  const b = budget.data;
  const codeOptions = (codes.data ?? []).map((c) => ({ value: c.id, label: `${c.code} ${c.description}` }));

  async function saveRow(costCodeId: string) {
    const e = edit[costCodeId];
    if (!e) return;
    const ok = await run(() => api("PUT", `/projects/${project.id}/budget/lines/${costCodeId}`, {
      ...(e.original !== undefined ? { originalAmount: e.original } : {}),
      ...(e.forecast !== undefined ? { forecastToComplete: e.forecast === "" ? null : e.forecast } : {}),
    }));
    if (ok) { setEdit(({ [costCodeId]: _, ...rest }) => rest); budget.reload(); }
  }

  const cols: [string, string][] = [
    ["original_budget", "Original"], ["budget_modifications", "Transfers"], ["approved_changes", "Approved COs"], ["revised_budget", "Revised budget"],
    ["committed_costs", "Committed"], ["pending_cost_changes", "Pending costs"], ["change_event_exposure", "Exposure"], ["direct_costs", "Cost to date"],
    ["estimated_cost_at_completion", "Est. at completion"], ["projected_over_under", "Over / under"],
  ];

  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Budget {b?.locked && <span className="badge badge-signed">Locked</span>}</h2>
        <div className="actions">
          <a className="button" href={`/api/projects/${project.id}/budget.csv`}>Export CSV</a>
          {manager && b && !b.locked && (codes.data?.length ?? 0) > 0 && (
            <ActionButton confirm="Lock the original budget? Later changes must be budget transfers or change orders." onClick={async () => { await api("POST", `/projects/${project.id}/budget/lock`); budget.reload(); }}>Lock budget</ActionButton>
          )}
        </div>
      </div>
      <ErrorText error={error ?? budget.error} />
      {manager && (
        <div className="grid-2">
          <Form ariaLabel="Import cost codes" submitLabel="Import cost codes" resetOnSuccess
            fields={[{ name: "csv", label: "Cost codes — one per line: code,description", type: "textarea", required: true, placeholder: "03-300,Cast-in-place concrete" }]}
            onSubmit={async (v) => { const r = await api("POST", `/projects/${project.id}/cost-codes`, { csv: v.csv }); codes.reload(); budget.reload(); if (!r.created) throw new Error("No new cost codes (all already exist)"); }} />
          {b?.locked && (
            <Form ariaLabel="Budget transfer" submitLabel="Transfer budget" resetOnSuccess
              fields={[
                { name: "fromCostCodeId", label: "From", type: "select", required: true, options: codeOptions },
                { name: "toCostCodeId", label: "To", type: "select", required: true, options: codeOptions },
                { name: "amount", label: "Amount", type: "money", required: true },
                { name: "reason", label: "Reason", required: true },
              ]}
              onSubmit={async (v) => { await api("POST", `/projects/${project.id}/budget/modifications`, v); budget.reload(); }} />
          )}
        </div>
      )}
      {!b ? <Loading /> : b.rows.length === 0 ? <Empty>No cost codes yet. Import them to start the budget.</Empty> : (
        <section className="card">
          <div className="table-wrap">
            <table className="table budget">
              <caption className="sr-only">Budget by cost code</caption>
              <thead><tr><th scope="col">Cost code</th>{cols.map(([, l]) => <th key={l} scope="col" className="num">{l}</th>)}<th scope="col" className="num">Forecast to complete</th>{manager && <th />}</tr></thead>
              <tbody>
                {b.rows.map((r: any) => {
                  const e = edit[r.cost_code_id];
                  return (
                    <tr key={r.cost_code_id}>
                      <th scope="row">{r.cost_code}<div className="muted small">{r.description}</div></th>
                      {cols.map(([k]) => (
                        <td key={k} className="num">
                          {k === "original_budget" && manager && !b.locked
                            ? <input aria-label={`Original budget ${r.cost_code}`} inputMode="decimal" className="num-input" value={e?.original ?? r.original_budget} onChange={(ev) => setEdit({ ...edit, [r.cost_code_id]: { ...e, original: ev.target.value } })} />
                            : <Money value={r[k]} signed={k === "projected_over_under"} />}
                        </td>
                      ))}
                      <td className="num">
                        {manager ? <input aria-label={`Forecast to complete ${r.cost_code}`} inputMode="decimal" className="num-input" placeholder="auto" value={e?.forecast ?? r.forecast_to_complete ?? ""} onChange={(ev) => setEdit({ ...edit, [r.cost_code_id]: { ...e, forecast: ev.target.value } })} /> : <Money value={r.forecast_to_complete} />}
                      </td>
                      {manager && <td>{e && <button onClick={() => saveRow(r.cost_code_id)}>Save</button>}</td>}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr><th scope="row">Total</th>{cols.map(([k]) => <td key={k} className="num"><strong><Money value={b.totals[k]} signed={k === "projected_over_under"} /></strong></td>)}<td />{manager && <td />}</tr>
              </tfoot>
            </table>
          </div>
          <p className="muted small">Revised = original + transfers + approved prime change orders. Estimate at completion = committed + pending cost changes + forecast to complete, or the revised budget when no forecast is entered and commitments are lower.</p>
        </section>
      )}
      {b?.modifications.length > 0 && (
        <section className="card">
          <h2>Budget transfers</h2>
          <DataTable rows={b.modifications} caption="Budget transfers" columns={[
            { label: "From", render: (m: any) => m.from_code }, { label: "To", render: (m: any) => m.to_code },
            { label: "Amount", render: (m: any) => <Money value={m.amount} /> }, { label: "Reason", render: (m: any) => m.reason },
            { label: "By", render: (m: any) => `${m.created_by_name} · ${fmtDate(m.created_at)}` },
          ]} />
        </section>
      )}
    </>
  );
}

// ---------------- Contracts ----------------

export function ContractsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/contracts`);
  const codes = useCostCodes(project.id);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Contracts</h2>
        {canManage(project.myRole) && (
          <Creator label="New contract">
            {(close) => <ContractForm project={project} codes={codes.data ?? []} onDone={() => { close(); list.reload(); }} onCancel={close} />}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(k) => `/contracts/${k.id}`} empty="No contracts yet." caption="Contracts" columns={[
          { label: "#", render: (k) => k.number },
          { label: "Title", render: (k) => k.title },
          { label: "Type", render: (k) => label(k.kind) },
          { label: "With", render: (k) => k.counterparty },
          { label: "Original", render: (k) => <Money value={k.original_amount} /> },
          { label: "Approved COs", render: (k) => <Money value={k.approved_changes} /> },
          { label: "Pending COs", render: (k) => <Money value={k.pending_changes} /> },
          { label: "Retainage", render: (k) => `${k.retainage_percent}%` },
          { label: "Status", render: (k) => <Badge value={k.status} /> },
        ]} />
      </section>
    </>
  );
}

function ContractForm({ project, codes, onDone, onCancel }: { project: ProjectInfo; codes: CostCode[]; onDone: () => void; onCancel: () => void }) {
  const [lines, setLines] = useState<Line[]>([{ costCodeId: "", description: "", amount: "" }]);
  return (
    <Form ariaLabel="New contract" submitLabel="Create contract" onCancel={onCancel} initial={{ kind: "subcontract", retainagePercent: "10" }}
      fields={[
        { name: "kind", label: "Type", type: "select", required: true, options: ["prime", "subcontract", "purchase_order"].map((v) => ({ value: v, label: label(v) })) },
        { name: "title", label: "Title", required: true },
        { name: "counterparty", label: "Owner / vendor", required: true },
        { name: "retainagePercent", label: "Retainage %", type: "number", step: "0.01", min: "0", max: "100" },
        { name: "executedDate", label: "Executed", type: "date" },
      ]}
      onSubmit={async (v) => { await api("POST", `/projects/${project.id}/contracts`, { ...v, executedDate: v.executedDate || null, retainagePercent: v.retainagePercent || "0", lines }); onDone(); }}>
      {codes.length ? <LinesEditor codes={codes} lines={lines} onChange={setLines} amountLabel="Scheduled value" /> : <p className="span-all notice">Add cost codes in the Budget tool first.</p>}
    </Form>
  );
}

export function ContractPage({ id }: { id: string }) {
  const r = useApi(`/contracts/${id}`);
  const k = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!k) return <Loading />;
  const manager = canManage(k.myRole);
  const setStatus = (status: string) => async () => { await api("POST", `/contracts/${k.id}/status`, { status }); r.reload(); };
  return (
    <>
      <PageHead back={{ to: `/projects/${k.project_id}/contracts`, label: "Contracts" }} title={<>{label(k.kind)} #{k.number}: {k.title} <Badge value={k.status} /></>} sub={`With ${k.counterparty} · retainage ${k.retainage_percent}%`}
        actions={manager && <>
          {k.status === "draft" && <ActionButton className="primary" onClick={setStatus("approved")}>Approve contract</ActionButton>}
          {k.status === "approved" && <ActionButton onClick={setStatus("complete")}>Mark complete</ActionButton>}
          {["draft", "approved"].includes(k.status) && <ActionButton className="danger" confirm="Terminate this contract?" onClick={setStatus("terminated")}>Terminate</ActionButton>}
        </>} />
      <section className="card">
        <KeyValues items={[["Original value", <Money value={k.totals.original} />], ["Approved changes", <Money value={k.totals.approved_changes} />], ["Revised value", <strong><Money value={k.totals.revised} /></strong>], ["Executed", fmtDate(k.executed_date)]]} />
      </section>
      <section className="card">
        <h2>Schedule of values</h2>
        <DataTable rows={k.sov} caption="Schedule of values" columns={[
          { label: "Cost code", render: (s: any) => s.cost_code }, { label: "Description", render: (s: any) => s.description },
          { label: "Source", render: (s: any) => s.source }, { label: "Scheduled value", render: (s: any) => <Money value={s.scheduled_value} /> },
        ]} />
      </section>
      <div className="grid-2">
        <section className="card">
          <h2>Change orders</h2>
          {k.changeOrders.length ? <ul className="list">{k.changeOrders.map((c: any) => <li key={c.id}><Link to={`/change-orders/${c.id}`}>CO #{c.number} {c.title}</Link> <Money value={c.amount} /> <Badge value={c.status} /></li>)}</ul> : <Empty>None.</Empty>}
        </section>
        <section className="card">
          <h2>Invoices</h2>
          {k.invoices.length ? <ul className="list">{k.invoices.map((i: any) => <li key={i.id}><Link to={`/invoices/${i.id}`}>Invoice #{i.number}</Link> {fmtDate(i.period_start)}–{fmtDate(i.period_end)} <Badge value={i.status} /></li>)}</ul> : <Empty>None.</Empty>}
        </section>
      </div>
    </>
  );
}

// ---------------- Change events ----------------

export function ChangeEventsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/change-events`);
  const codes = useCostCodes(project.id);
  const [lines, setLines] = useState<Line[]>([]);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Change events</h2>
        {canWrite(project.myRole) && (
          <Creator label="New change event">
            {(close) => (
              <Form ariaLabel="New change event" submitLabel="Create change event" onCancel={close} initial={{ reason: "owner_change", scope: "tbd" }}
                fields={[
                  { name: "title", label: "Title", required: true, full: true },
                  { name: "reason", label: "Reason", type: "select", required: true, options: ["owner_change", "design_error", "unforeseen_condition", "allowance", "other"].map((v) => ({ value: v, label: label(v) })) },
                  { name: "scope", label: "Scope", type: "select", required: true, options: ["in_scope", "out_of_scope", "tbd"].map((v) => ({ value: v, label: v === "tbd" ? "TBD" : label(v) })) },
                  { name: "description", label: "Description", type: "textarea" },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/change-events`, { ...v, description: v.description || null, lines: lines.map((l) => ({ costCodeId: l.costCodeId, description: l.description, estimatedCost: l.amount || "0" })) });
                  setLines([]); close(); list.reload();
                }}>
                <LinesEditor codes={codes.data ?? []} lines={lines} onChange={setLines} amountLabel="Estimated cost" allowNegative />
              </Form>
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(c) => `/change-events/${c.id}`} empty="No change events." caption="Change events" columns={[
          { label: "#", render: (c) => c.number }, { label: "Title", render: (c) => c.title },
          { label: "Reason", render: (c) => label(c.reason) }, { label: "Scope", render: (c) => label(c.scope) },
          { label: "Est. cost", render: (c) => <Money value={c.estimated_cost} /> }, { label: "COs", render: (c) => c.change_orders },
          { label: "Status", render: (c) => <Badge value={c.status} /> },
        ]} />
      </section>
    </>
  );
}

export function ChangeEventPage({ id }: { id: string }) {
  const r = useApi(`/change-events/${id}`);
  const ce = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!ce) return <Loading />;
  return (
    <>
      <PageHead back={{ to: `/projects/${ce.project_id}/change-events`, label: "Change events" }} title={<>Change event #{ce.number}: {ce.title} <Badge value={ce.status} /></>} sub={`${label(ce.reason)} · ${label(ce.scope)}`}
        actions={canManage(ce.myRole) && ce.status === "open" && <ActionButton onClick={async () => { await api("PATCH", `/change-events/${ce.id}`, { status: "closed" }); r.reload(); }}>Close event</ActionButton>} />
      {ce.description && <section className="card"><p className="pre">{ce.description}</p></section>}
      <section className="card">
        <h2>Estimate</h2>
        <DataTable rows={ce.lines} empty="No estimate lines." caption="Estimate" columns={[
          { label: "Cost code", render: (l: any) => l.cost_code }, { label: "Description", render: (l: any) => l.description },
          { label: "Est. cost", render: (l: any) => <Money value={l.estimated_cost} /> }, { label: "Est. revenue", render: (l: any) => <Money value={l.estimated_revenue} /> },
        ]} />
      </section>
      <section className="card">
        <h2>Change orders</h2>
        {ce.changeOrders.length ? <ul className="list">{ce.changeOrders.map((c: any) => <li key={c.id}><Link to={`/change-orders/${c.id}`}>CO #{c.number} {c.title}</Link> <span className="muted">{label(c.kind)} · {c.contract_title}</span> <Badge value={c.status} /></li>)}</ul> : <Empty>No change orders yet — create one from the Change orders tool.</Empty>}
      </section>
      <Comments entityType="change_event" entityId={ce.id} projectId={ce.project_id} />
    </>
  );
}

// ---------------- Change orders ----------------

export function ChangeOrdersTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/change-orders`);
  const contracts = useApi<any[]>(`/projects/${project.id}/contracts`);
  const events = useApi<any[]>(`/projects/${project.id}/change-events`);
  const codes = useCostCodes(project.id);
  const [lines, setLines] = useState<Line[]>([{ costCodeId: "", description: "", amount: "" }]);
  const approved = (contracts.data ?? []).filter((k) => k.status === "approved");
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Change orders</h2>
        {canWrite(project.myRole) && (
          <Creator label="New change order">
            {(close) => approved.length === 0 ? <p className="notice">Approve a contract first. <button className="link" onClick={close}>Close</button></p> : (
              <Form ariaLabel="New change order" submitLabel="Create change order" onCancel={close}
                fields={[
                  { name: "contractId", label: "Contract", type: "select", required: true, options: approved.map((k) => ({ value: k.id, label: `#${k.number} ${k.title} (${label(k.kind)})` })) },
                  { name: "changeEventId", label: "Change event", type: "select", options: (events.data ?? []).filter((e) => e.status === "open").map((e) => ({ value: e.id, label: `#${e.number} ${e.title}` })) },
                  { name: "title", label: "Title", required: true },
                  { name: "scheduleImpactDays", label: "Schedule impact (days)", type: "number", step: "1" },
                  { name: "description", label: "Description", type: "textarea" },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/change-orders`, { contractId: v.contractId, changeEventId: v.changeEventId || null, title: v.title, description: v.description || null, scheduleImpactDays: Number(v.scheduleImpactDays) || 0, lines });
                  setLines([{ costCodeId: "", description: "", amount: "" }]); close(); list.reload();
                }}>
                <LinesEditor codes={codes.data ?? []} lines={lines} onChange={setLines} allowNegative />
              </Form>
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(c) => `/change-orders/${c.id}`} empty="No change orders." caption="Change orders" columns={[
          { label: "#", render: (c) => c.number }, { label: "Title", render: (c) => c.title },
          { label: "Contract", render: (c) => `${c.contract_title} (${label(c.kind)})` },
          { label: "Amount", render: (c) => <Money value={c.amount} signed /> },
          { label: "Days", render: (c) => c.schedule_impact_days },
          { label: "Event", render: (c) => c.change_event_number ? `#${c.change_event_number}` : "—" },
          { label: "Status", render: (c) => <Badge value={c.status} /> },
        ]} />
      </section>
    </>
  );
}

function SubmitForApproval({ projectId, path, onDone, label: text }: { projectId: string; path: string; onDone: () => void; label: string }) {
  const { options } = useMemberOptions(projectId, (m) => m.role === "admin" || m.role === "manager");
  return (
    <Form ariaLabel={text} submitLabel={text} className="compact"
      fields={[{ name: "first", label: "Approver", type: "select", required: true, options }, { name: "second", label: "Second approver (optional)", type: "select", options }]}
      onSubmit={async (v) => { await api("POST", path, { approverIds: [v.first, v.second].filter(Boolean) }); onDone(); }} />
  );
}

export function ChangeOrderPage({ id }: { id: string }) {
  const r = useApi(`/change-orders/${id}`);
  const co = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!co) return <Loading />;
  return (
    <>
      <PageHead back={{ to: `/projects/${co.project_id}/change-orders`, label: "Change orders" }} title={<>Change order #{co.number}: {co.title} <Badge value={co.status} /></>}
        sub={<>On <Link to={`/contracts/${co.contract.id}`}>{label(co.contract.kind)} #{co.contract.number} {co.contract.title}</Link> with {co.contract.counterparty}</>}
        actions={canManage(co.myRole) && ["draft", "pending", "rejected"].includes(co.status) && <ActionButton className="danger" confirm="Void this change order?" onClick={async () => { await api("POST", `/change-orders/${co.id}/void`); r.reload(); }}>Void</ActionButton>} />
      <section className="card">
        <KeyValues items={[["Total", <strong><Money value={co.total} signed /></strong>], ["Schedule impact", `${co.schedule_impact_days} days`], ["Description", co.description]]} />
        <DataTable rows={co.lines} caption="Change order lines" columns={[
          { label: "Cost code", render: (l: any) => l.cost_code }, { label: "Description", render: (l: any) => l.description }, { label: "Amount", render: (l: any) => <Money value={l.amount} signed /> },
        ]} />
      </section>
      {canWrite(co.myRole) && ["draft", "rejected"].includes(co.status) && <SubmitForApproval projectId={co.project_id} path={`/change-orders/${co.id}/submit`} onDone={r.reload} label="Submit for approval" />}
      <Approvals steps={co.approvals} myId={co.myId} onDecided={r.reload} />
      <Comments entityType="change_order" entityId={co.id} projectId={co.project_id} />
    </>
  );
}

// ---------------- Invoices / pay applications ----------------

export function InvoicesTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/invoices`);
  const contracts = useApi<any[]>(`/projects/${project.id}/contracts`);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Invoices & pay applications</h2>
        {canWrite(project.myRole) && (
          <Creator label="New invoice">
            {(close) => (
              <Form ariaLabel="New invoice" submitLabel="Create invoice" onCancel={close} initial={{ periodStart: today().slice(0, 8) + "01", periodEnd: today() }}
                fields={[
                  { name: "contractId", label: "Contract", type: "select", required: true, options: (contracts.data ?? []).filter((k) => k.status === "approved").map((k) => ({ value: k.id, label: `#${k.number} ${k.title} (${k.counterparty})` })) },
                  { name: "periodStart", label: "Period start", type: "date", required: true },
                  { name: "periodEnd", label: "Period end", type: "date", required: true },
                ]}
                onSubmit={async (v) => { const i = await api("POST", `/projects/${project.id}/invoices`, v); close(); location.assign(`/invoices/${i.id}`); }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(i) => `/invoices/${i.id}`} empty="No invoices yet." caption="Invoices" columns={[
          { label: "#", render: (i) => i.number }, { label: "Contract", render: (i) => `${i.contract_title} (${label(i.kind)})` },
          { label: "From / to", render: (i) => i.counterparty }, { label: "Period", render: (i) => `${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}` },
          { label: "Completed to date", render: (i) => <Money value={i.completed_to_date} /> }, { label: "Retainage", render: (i) => <Money value={i.retainage} /> },
          { label: "Payment due", render: (i) => <Money value={i.current_payment_due} /> }, { label: "Status", render: (i) => <Badge value={i.status} /> },
        ]} />
      </section>
    </>
  );
}

export function InvoicePage({ id }: { id: string }) {
  const r = useApi(`/invoices/${id}`);
  const [draft, setDraft] = useState<Record<string, { w?: string; s?: string }>>({});
  const { busy, error, run } = useAction();
  const pa = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!pa) return <Loading />;
  const inv = pa.invoice;
  const editable = canWrite(pa.myRole) && ["draft", "rejected"].includes(inv.status);
  const t = pa.totals;
  async function save() {
    const ok = await run(() => api("PUT", `/invoices/${inv.id}/lines`, {
      lines: pa.lines.map((l: any) => ({ key: l.key, workThisPeriod: draft[l.key]?.w ?? l.work_this_period, materialsStored: draft[l.key]?.s ?? l.materials_stored })),
    }));
    if (ok) { setDraft({}); r.reload(); }
  }
  return (
    <>
      <PageHead back={{ to: `/projects/${inv.project_id}/invoices`, label: "Invoices" }} title={<>Invoice #{inv.number} <Badge value={inv.status} /></>}
        sub={<>{label(pa.contract.kind)} <Link to={`/contracts/${pa.contract.id}`}>#{pa.contract.number} {pa.contract.title}</Link> · {pa.contract.counterparty} · period {fmtDate(inv.period_start)} – {fmtDate(inv.period_end)} · retainage {pa.retainage_percent}%</>}
        actions={<>
          <a className="button" href={`/api/invoices/${inv.id}/g703.csv`}>Export G703 CSV</a>
          {canManage(pa.myRole) && inv.status === "approved" && <ActionButton className="primary" onClick={async () => { await api("POST", `/invoices/${inv.id}/paid`); r.reload(); }}>Mark paid</ActionButton>}
          {editable && <ActionButton className="danger" confirm="Delete this invoice?" onClick={async () => { await api("DELETE", `/invoices/${inv.id}`); location.assign(`/projects/${inv.project_id}/invoices`); }}>Delete</ActionButton>}
        </>} />
      <section className="card summary" aria-label="Application summary">
        <KeyValues items={[
          ["Original contract sum", <Money value={t.original_contract_sum} />], ["Net change by change orders", <Money value={t.net_change_by_change_orders} signed />],
          ["Contract sum to date", <Money value={t.contract_sum_to_date} />], ["Completed & stored to date", <Money value={t.completed_to_date} />],
          ["Retainage", <Money value={t.retainage} />], ["Earned less retainage", <Money value={t.earned_less_retainage} />],
          ["Less previous certificates", <Money value={t.previous_certificates} />], ["Current payment due", <strong className="due"><Money value={t.current_payment_due} /></strong>],
          ["Balance to finish incl. retainage", <Money value={t.balance_to_finish_including_retainage} />],
        ]} />
      </section>
      {pa.overbilled.length > 0 && <p className="error" role="alert">Billing exceeds the scheduled value on: {pa.overbilled.join("; ")}</p>}
      <section className="card">
        <h2>Continuation sheet (G703)</h2>
        <div className="table-wrap">
          <table className="table payapp">
            <thead><tr><th>Cost code</th><th>Description</th><th className="num">Scheduled value</th><th className="num">Previous</th><th className="num">This period</th><th className="num">Stored materials</th><th className="num">Completed to date</th><th className="num">%</th><th className="num">Balance</th><th className="num">Retainage</th></tr></thead>
            <tbody>
              {pa.lines.map((l: any) => (
                <tr key={l.key}>
                  <td>{l.cost_code}</td><td>{l.description}<div className="muted small">{l.source}</div></td>
                  <td className="num"><Money value={l.scheduled_value} /></td><td className="num"><Money value={l.previous_work} /></td>
                  <td className="num">{editable ? <input aria-label={`This period ${l.description}`} inputMode="decimal" className="num-input" value={draft[l.key]?.w ?? l.work_this_period} onChange={(e) => setDraft({ ...draft, [l.key]: { ...draft[l.key], w: e.target.value } })} /> : <Money value={l.work_this_period} />}</td>
                  <td className="num">{editable ? <input aria-label={`Stored materials ${l.description}`} inputMode="decimal" className="num-input" value={draft[l.key]?.s ?? l.materials_stored} onChange={(e) => setDraft({ ...draft, [l.key]: { ...draft[l.key], s: e.target.value } })} /> : <Money value={l.materials_stored} />}</td>
                  <td className="num"><Money value={l.completed_to_date} /></td><td className="num">{l.percent_complete}</td>
                  <td className="num"><Money value={l.balance_to_finish} /></td><td className="num"><Money value={l.retainage} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorText error={error} />
        {editable && <div className="actions"><button className="primary" disabled={busy || !Object.keys(draft).length} onClick={save}>Save amounts</button></div>}
      </section>
      {editable && inv.status === "draft" && <SubmitForApproval projectId={inv.project_id} path={`/invoices/${inv.id}/submit`} onDone={r.reload} label="Submit for approval" />}
      <Approvals steps={pa.approvals} myId={pa.myId} onDecided={r.reload} />
      <Comments entityType="invoice" entityId={inv.id} projectId={inv.project_id} />
    </>
  );
}


