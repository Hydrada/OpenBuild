import { useState } from "react";
import { api, fmtDate, fmtDateTime, label, today } from "../../api";
import { Attachments, Comments, canManage, canWrite, useMemberOptions } from "../../components/records";
import { ActionButton, Badge, Creator, DataTable, ErrorText, Form, KeyValues, Loading, Money, PageHead } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

const KINDS = [
  { value: "transmittal", label: "Transmittal", prefix: "TR" },
  { value: "notice", label: "Notice", prefix: "NOT" },
  { value: "instruction", label: "Instruction", prefix: "INS" },
  { value: "letter", label: "Letter", prefix: "LTR" },
  { value: "memo", label: "Memo", prefix: "MEM" },
];
const corrNo = (c: { kind: string; number: number }) => `${KINDS.find((k) => k.value === c.kind)?.prefix ?? ""}-${String(c.number).padStart(3, "0")}`;

function useCostCodeOptions(projectId: string) {
  const codes = useApi<{ id: string; code: string; description: string }[]>(`/projects/${projectId}/cost-codes`);
  return (codes.data ?? []).map((c) => ({ value: c.id, label: `${c.code} ${c.description}` }));
}

// ---------------- Correspondence ----------------

export function CorrespondenceTool({ project }: { project: ProjectInfo }) {
  const [kind, setKind] = useState("");
  const list = useApi<any[]>(`/projects/${project.id}/correspondence${kind ? `?kind=${kind}` : ""}`);
  const { options } = useMemberOptions(project.id);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Correspondence</h2>
        <label className="inline">Type <select aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All</option>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select></label>
        {canWrite(project.myRole) && (
          <Creator label="New correspondence">
            {(close) => (
              <Form ariaLabel="New correspondence" submitLabel="Send" onCancel={close} initial={{ kind: "transmittal", recipientIds: [] }}
                fields={[
                  { name: "kind", label: "Type", type: "select", required: true, options: KINDS },
                  { name: "subject", label: "Subject", required: true, full: true },
                  { name: "recipientIds", label: "To (Ctrl/Cmd-click for several)", type: "multiselect", options },
                  { name: "dueDate", label: "Response due", type: "date" },
                  { name: "body", label: "Message", type: "textarea", full: true },
                  { name: "private", label: "Private (author, recipients and managers only)", type: "checkbox" },
                  { name: "draft", label: "Save as draft (don't send yet)", type: "checkbox" },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/correspondence`, {
                    kind: v.kind, subject: v.subject, body: v.body || null, dueDate: v.dueDate || null,
                    recipientIds: v.recipientIds, private: !!v.private, draft: !!v.draft,
                  });
                  close(); list.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(c) => `/correspondence/${c.id}`} empty="No correspondence yet." caption="Correspondence" columns={[
          { label: "#", render: (c) => corrNo(c) },
          { label: "Type", render: (c) => label(c.kind) },
          { label: "Subject", render: (c) => <>{c.subject}{c.private && <span className="muted small"> · private</span>}</> },
          { label: "From", render: (c) => c.created_by_name ?? "—" },
          { label: "Acknowledged", render: (c) => `${c.acknowledged}/${c.recipients}` },
          { label: "Due", render: (c) => fmtDate(c.due_date) },
          { label: "Status", render: (c) => <Badge value={c.status} /> },
        ]} />
      </section>
    </>
  );
}

export function CorrespondencePage({ id }: { id: string }) {
  const r = useApi(`/correspondence/${id}`);
  const c = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!c) return <Loading />;
  const me = c.recipients.find((x: any) => x.user_id === c.myId);
  return (
    <>
      <PageHead back={{ to: `/projects/${c.project_id}/correspondence`, label: "Correspondence" }}
        title={<>{corrNo(c)} {c.subject} <Badge value={c.status} /></>}
        sub={`${label(c.kind)} from ${c.created_by_name ?? "—"} · ${fmtDateTime(c.created_at)}${c.due_date ? ` · response due ${fmtDate(c.due_date)}` : ""}`}
        actions={<>
          {c.status === "draft" && c.canEdit && <ActionButton className="primary" onClick={async () => { await api("POST", `/correspondence/${id}/send`); r.reload(); }}>Send</ActionButton>}
          {me && !me.acknowledged_at && c.status !== "draft" && <ActionButton className="primary" onClick={async () => { await api("POST", `/correspondence/${id}/acknowledge`); r.reload(); }}>Acknowledge receipt</ActionButton>}
          {c.canEdit && c.status === "open" && <ActionButton onClick={async () => { await api("POST", `/correspondence/${id}/status`, { status: "closed" }); r.reload(); }}>Close</ActionButton>}
          {c.canEdit && c.status === "closed" && <ActionButton onClick={async () => { await api("POST", `/correspondence/${id}/status`, { status: "open" }); r.reload(); }}>Reopen</ActionButton>}
        </>} />
      <section className="card">
        <h2>Message</h2>
        <p className="pre">{c.body || "—"}</p>
      </section>
      <section className="card" aria-label="Recipients">
        <h2>Recipients</h2>
        <DataTable rows={c.recipients.map((x: any) => ({ ...x, id: x.user_id }))} empty="No recipients." caption="Recipients" columns={[
          { label: "Name", render: (x: any) => x.name },
          { label: "Acknowledged", render: (x: any) => (x.acknowledged_at ? fmtDateTime(x.acknowledged_at) : "Not yet") },
        ]} />
      </section>
      <Attachments entityType="correspondence" entityId={c.id} projectId={c.project_id} files={c.files} onChange={r.reload} canAdd={canWrite(c.myRole)} />
      {c.myRole !== "subcontractor" && <Comments entityType="correspondence" entityId={c.id} projectId={c.project_id} />}
    </>
  );
}

// ---------------- Direct costs ----------------

export function DirectCostsTool({ project }: { project: ProjectInfo }) {
  const list = useApi(`/projects/${project.id}/direct-costs`);
  const codeOptions = useCostCodeOptions(project.id);
  const manager = canManage(project.myRole);
  const { error, run } = useAction();
  const setStatus = (id: string, status: string) => run(async () => { await api("POST", `/direct-costs/${id}/status`, { status }); list.reload(); });
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Direct costs</h2>
        {canWrite(project.myRole) && (
          <Creator label="New direct cost">
            {(close) => (
              <Form ariaLabel="New direct cost" submitLabel="Add cost" onCancel={close} initial={{ kind: "expense", costDate: today() }}
                fields={[
                  { name: "kind", label: "Type", type: "select", required: true, options: [
                    { value: "expense", label: "Expense" }, { value: "invoice", label: "Vendor invoice" },
                    { value: "payroll", label: "Payroll" }, { value: "subcontractor_invoice", label: "Subcontractor invoice (no commitment)" }] },
                  { name: "costDate", label: "Date", type: "date", required: true },
                  { name: "costCodeId", label: "Cost code", type: "select", required: true, options: codeOptions },
                  { name: "amount", label: "Amount", type: "money", required: true },
                  { name: "vendor", label: "Vendor / employee" },
                  { name: "reference", label: "Reference (invoice #, receipt)" },
                  { name: "description", label: "Description", required: true, full: true },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/direct-costs`, {
                    kind: v.kind, costDate: v.costDate, costCodeId: v.costCodeId, amount: String(v.amount).replace(/,/g, ""),
                    vendor: v.vendor || null, reference: v.reference || null, description: v.description,
                  });
                  close(); list.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error ?? error} />
        {list.data && <p>Approved <Money value={list.data.approvedTotal} /> · pending <Money value={list.data.pendingTotal} /> <span className="muted small">Approved costs count in the budget's direct costs and estimate at completion.</span></p>}
        <DataTable rows={list.data?.rows} empty="No direct costs yet." caption="Direct costs" columns={[
          { label: "Date", render: (d: any) => fmtDate(d.cost_date) },
          { label: "Type", render: (d: any) => label(d.kind) },
          { label: "Cost code", render: (d: any) => d.cost_code },
          { label: "Description", render: (d: any) => <>{d.description}{d.vendor && <div className="muted small">{d.vendor}{d.reference ? ` · ${d.reference}` : ""}</div>}</> },
          { label: "Amount", render: (d: any) => <Money value={d.amount} /> },
          { label: "Status", render: (d: any) => <Badge value={d.status} /> },
          { label: "", render: (d: any) => manager && d.status === "pending" ? <>
            <button type="button" onClick={() => setStatus(d.id, "approved")}>Approve</button>{" "}
            <button type="button" className="link danger" onClick={() => setStatus(d.id, "rejected")}>Reject</button>
          </> : null },
        ]} />
      </section>
    </>
  );
}

// ---------------- T&M tickets ----------------

interface TmLine { category: string; description: string; quantity: string; unit: string; rate: string; costCodeId: string }
const blankLine = (): TmLine => ({ category: "labor", description: "", quantity: "", unit: "hr", rate: "", costCodeId: "" });

function TmLinesEditor({ lines, onChange, codeOptions }: { lines: TmLine[]; onChange: (l: TmLine[]) => void; codeOptions: { value: string; label: string }[] }) {
  const set = (i: number, k: keyof TmLine, v: string) => onChange(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <div className="span-all">
      <div className="table-wrap">
        <table className="table lines">
          <thead><tr><th>Type</th><th>Description</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Cost code</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><select aria-label={`Type line ${i + 1}`} value={l.category} onChange={(e) => set(i, "category", e.target.value)}>
                  <option value="labor">Labor</option><option value="material">Material</option><option value="equipment">Equipment</option></select></td>
                <td><input aria-label={`Description line ${i + 1}`} required value={l.description} onChange={(e) => set(i, "description", e.target.value)} /></td>
                <td><input aria-label={`Quantity line ${i + 1}`} required inputMode="decimal" pattern="[0-9]*(\.[0-9]{0,2})?" size={6} value={l.quantity} onChange={(e) => set(i, "quantity", e.target.value)} /></td>
                <td><input aria-label={`Unit line ${i + 1}`} size={5} value={l.unit} onChange={(e) => set(i, "unit", e.target.value)} /></td>
                <td><input aria-label={`Rate line ${i + 1}`} required inputMode="decimal" pattern="[0-9,]*(\.[0-9]{0,2})?" size={8} value={l.rate} onChange={(e) => set(i, "rate", e.target.value)} /></td>
                <td><select aria-label={`Cost code line ${i + 1}`} value={l.costCodeId} onChange={(e) => set(i, "costCodeId", e.target.value)}>
                  <option value="">—</option>{codeOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></td>
                <td><button type="button" className="link danger" onClick={() => onChange(lines.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => onChange([...lines, blankLine()])}>Add line</button>
    </div>
  );
}

const toApiLines = (lines: TmLine[]) => lines.map((l) => ({ category: l.category, description: l.description, quantity: l.quantity, unit: l.unit || null, rate: l.rate.replace(/,/g, ""), costCodeId: l.costCodeId || null }));

export function TmTicketsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/tm-tickets`);
  const codeOptions = useCostCodeOptions(project.id);
  const [lines, setLines] = useState<TmLine[]>([blankLine()]);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">T&amp;M tickets</h2>
        {canWrite(project.myRole) && (
          <Creator label="New T&M ticket">
            {(close) => (
              <Form ariaLabel="New T&M ticket" submitLabel="Create ticket" onCancel={close} initial={{ workDate: today() }}
                fields={[
                  { name: "workDate", label: "Work date", type: "date", required: true },
                  { name: "company", label: "Performed by (company)" },
                  { name: "description", label: "Work performed", type: "textarea", required: true, full: true },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/tm-tickets`, { workDate: v.workDate, company: v.company || null, description: v.description, lines: toApiLines(lines) });
                  setLines([blankLine()]); close(); list.reload();
                }}>
                <TmLinesEditor lines={lines} onChange={setLines} codeOptions={codeOptions} />
              </Form>
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(t) => `/tm-tickets/${t.id}`} empty="No T&M tickets yet." caption="T&M tickets" columns={[
          { label: "#", render: (t) => t.number },
          { label: "Date", render: (t) => fmtDate(t.work_date) },
          { label: "Work", render: (t) => t.description },
          { label: "Company", render: (t) => t.company ?? "—" },
          { label: "Total", render: (t) => <Money value={t.total} /> },
          { label: "Signed by", render: (t) => t.signed_by ?? "—" },
          { label: "Status", render: (t) => <Badge value={t.status} /> },
        ]} />
      </section>
    </>
  );
}

export function TmTicketPage({ id }: { id: string }) {
  const r = useApi(`/tm-tickets/${id}`);
  const t = r.data;
  const { error, run } = useAction();
  const [signedBy, setSignedBy] = useState("");
  if (r.error) return <ErrorText error={r.error} />;
  if (!t) return <Loading />;
  const manager = canManage(t.myRole);
  const status = (s: string, extra: object = {}) => run(async () => { await api("POST", `/tm-tickets/${id}/status`, { status: s, ...extra }); r.reload(); });
  return (
    <>
      <PageHead pdf={`/tm-tickets/${t.id}/pdf`} back={{ to: `/projects/${t.project_id}/tm-tickets`, label: "T&M tickets" }} title={<>T&amp;M ticket #{t.number} <Badge value={t.status} /></>}
        sub={`${fmtDate(t.work_date)}${t.company ? ` · ${t.company}` : ""}`}
        actions={<>
          {manager && t.status === "submitted" && <>
            <ActionButton className="primary" onClick={() => status("approved")}>Approve</ActionButton>
            <ActionButton onClick={() => status("rejected")}>Reject</ActionButton>
          </>}
          {manager && t.status === "approved" && !t.change_event_id && <ActionButton className="primary" onClick={async () => { await api("POST", `/tm-tickets/${id}/change-event`); r.reload(); }}>Create change event</ActionButton>}
        </>} />
      <section className="card">
        <KeyValues items={[
          ["Work performed", <span className="pre">{t.description}</span>],
          ["Signed in the field by", t.signed_by ? `${t.signed_by} · ${fmtDateTime(t.signed_at)}` : "Not signed"],
          ["Change event", t.change_event_id ? <a href={`/change-events/${t.change_event_id}`}>#{t.change_event_number}</a> : "—"],
        ]} />
      </section>
      <section className="card" aria-label="Lines">
        <h2>Labor, material and equipment</h2>
        <DataTable rows={t.lines} empty="No lines." caption="Ticket lines" columns={[
          { label: "Type", render: (l: any) => label(l.category) },
          { label: "Description", render: (l: any) => l.description },
          { label: "Qty", render: (l: any) => `${l.quantity}${l.unit ? ` ${l.unit}` : ""}` },
          { label: "Rate", render: (l: any) => <Money value={l.rate} /> },
          { label: "Cost code", render: (l: any) => l.cost_code ?? "—" },
          { label: "Amount", render: (l: any) => <Money value={l.amount} /> },
        ]} />
        <p>Labor <Money value={t.subtotals.labor} /> · material <Money value={t.subtotals.material} /> · equipment <Money value={t.subtotals.equipment} /> · <strong>total <Money value={t.total} /></strong></p>
      </section>
      {canWrite(t.myRole) && (t.status === "draft" || t.status === "rejected") && (
        <section className="card" aria-label="Submit">
          <h2>Submit for approval</h2>
          <form className="row" onSubmit={(e) => { e.preventDefault(); status("submitted", { signedBy }); }}>
            <label>Signed in the field by <input required value={signedBy} onChange={(e) => setSignedBy(e.target.value)} placeholder="Name of owner's representative" /></label>
            <button className="primary" type="submit">Submit ticket</button>
          </form>
        </section>
      )}
      <ErrorText error={error} />
      <Attachments entityType="tm_ticket" entityId={t.id} projectId={t.project_id} files={t.files} onChange={r.reload} canAdd={canWrite(t.myRole)} title="Signed ticket and backup" />
      <Comments entityType="tm_ticket" entityId={t.id} projectId={t.project_id} />
    </>
  );
}

// ---------------- Equipment ----------------

export function EquipmentTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/equipment`);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Equipment</h2>
        {canWrite(project.myRole) && (
          <Creator label="Add equipment">
            {(close) => (
              <Form ariaLabel="Add equipment" submitLabel="Add equipment" onCancel={close} initial={{ ownership: "owned", status: "on_site", hourlyRate: "0" }}
                fields={[
                  { name: "name", label: "Name", required: true, placeholder: "CAT 320 excavator" },
                  { name: "category", label: "Category" },
                  { name: "ownership", label: "Ownership", type: "select", required: true, options: [{ value: "owned", label: "Owned" }, { value: "rented", label: "Rented" }, { value: "subcontractor", label: "Subcontractor's" }] },
                  { name: "identifier", label: "Serial / fleet #" },
                  { name: "hourlyRate", label: "Hourly rate", type: "money" },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/equipment`, { name: v.name, category: v.category || null, ownership: v.ownership, identifier: v.identifier || null, hourlyRate: String(v.hourlyRate || "0").replace(/,/g, "") });
                  close(); list.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(e) => `/equipment/${e.id}`} empty="No equipment yet." caption="Equipment" columns={[
          { label: "Name", render: (e) => e.name },
          { label: "Category", render: (e) => e.category ?? "—" },
          { label: "Ownership", render: (e) => label(e.ownership) },
          { label: "Hours operated", render: (e) => e.hours_operated },
          { label: "Hours idle", render: (e) => e.hours_idle },
          { label: "Last used", render: (e) => fmtDate(e.last_used) },
          { label: "Status", render: (e) => <Badge value={e.status} /> },
        ]} />
      </section>
    </>
  );
}

export function EquipmentPage({ id }: { id: string }) {
  const r = useApi(`/equipment/${id}`);
  const e = r.data;
  const codeOptions = useCostCodeOptions(e?.project_id ?? "");
  if (r.error) return <ErrorText error={r.error} />;
  if (!e) return <Loading />;
  return (
    <>
      <PageHead back={{ to: `/projects/${e.project_id}/equipment`, label: "Equipment" }} title={<>{e.name} <Badge value={e.status} /></>}
        sub={`${label(e.ownership)}${e.identifier ? ` · ${e.identifier}` : ""} · ${e.hoursOperated} h operated · operating cost ${e.operatingCost} at ${e.hourly_rate}/h`}
        actions={canWrite(e.myRole) && (
          <select aria-label="Equipment status" value={e.status} onChange={(ev) => api("PATCH", `/equipment/${id}`, { status: ev.target.value }).then(r.reload)}>
            <option value="on_site">On site</option><option value="off_site">Off site</option><option value="down">Down for repair</option>
          </select>
        )} />
      {canWrite(e.myRole) && (
        <section className="card" aria-label="Log hours">
          <h2>Log hours</h2>
          <Form ariaLabel="Log equipment hours" submitLabel="Log hours" resetOnSuccess initial={{ logDate: today(), hoursOperated: "", hoursIdle: "0" }}
            fields={[
              { name: "logDate", label: "Date", type: "date", required: true },
              { name: "hoursOperated", label: "Hours operated", type: "number", min: "0", max: "24", step: "0.25", required: true },
              { name: "hoursIdle", label: "Hours idle", type: "number", min: "0", max: "24", step: "0.25" },
              { name: "costCodeId", label: "Cost code", type: "select", options: codeOptions },
              { name: "notes", label: "Notes", full: true },
            ]}
            onSubmit={async (v) => {
              await api("POST", `/equipment/${id}/logs`, { logDate: v.logDate, hoursOperated: Number(v.hoursOperated), hoursIdle: Number(v.hoursIdle) || 0, costCodeId: v.costCodeId || null, notes: v.notes || null });
              r.reload();
            }} />
        </section>
      )}
      <section className="card" aria-label="Usage log">
        <h2>Usage log</h2>
        <DataTable rows={e.logs} empty="No hours logged." caption="Usage log" columns={[
          { label: "Date", render: (l: any) => fmtDate(l.log_date) },
          { label: "Operated", render: (l: any) => l.hours_operated },
          { label: "Idle", render: (l: any) => l.hours_idle },
          { label: "Cost code", render: (l: any) => l.cost_code ?? "—" },
          { label: "Notes", render: (l: any) => l.notes ?? "" },
          { label: "By", render: (l: any) => l.created_by_name ?? "—" },
        ]} />
      </section>
    </>
  );
}
