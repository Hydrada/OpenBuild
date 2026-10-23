import { useState } from "react";
import { api, fmtDate, label, today, upload } from "../../api";
import { useMemberOptions } from "../../components/records";
import { ActionButton, Badge, DataTable, Empty, ErrorText, Form, Money } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

const DOC_KINDS = [
  { value: "general_liability", label: "General liability" }, { value: "workers_comp", label: "Workers' compensation" },
  { value: "auto", label: "Auto" }, { value: "umbrella", label: "Umbrella" }, { value: "w9", label: "W-9" },
  { value: "license", label: "License" }, { value: "other", label: "Other" },
];
const WAIVER_KINDS = [
  { value: "conditional_progress", label: "Conditional progress" }, { value: "unconditional_progress", label: "Unconditional progress" },
  { value: "conditional_final", label: "Conditional final" }, { value: "unconditional_final", label: "Unconditional final" },
];

/** Payment requirements; the boxes tick immediately and save in the background. */
function Requirements({ contractId, initial, onSaved, run }: { contractId: string; initial: { requireInsurance: boolean; requireLienWaivers: boolean }; onSaved: () => void; run: (f: () => Promise<unknown>) => Promise<unknown> }) {
  const [v, setV] = useState(initial);
  const set = (key: "requireInsurance" | "requireLienWaivers", on: boolean) => {
    const prev = v;
    setV({ ...v, [key]: on });
    run(async () => {
      try { await api("PATCH", `/contracts/${contractId}/requirements`, { [key]: on }); onSaved(); } catch (e) { setV(prev); throw e; }
    });
  };
  return (
    <div className="row">
      <label className="check"><input type="checkbox" checked={v.requireInsurance} onChange={(e) => set("requireInsurance", e.target.checked)} /> Require insurance before payment</label>
      <label className="check"><input type="checkbox" checked={v.requireLienWaivers} onChange={(e) => set("requireLienWaivers", e.target.checked)} /> Require lien waivers before payment</label>
    </div>
  );
}

/** Insurance and other compliance documents on a commitment. Contacts upload; managers accept or reject. */
export function ComplianceSection({ contractId, projectId, manager, canUpload }: { contractId: string; projectId: string; manager: boolean; canUpload: boolean }) {
  const r = useApi(`/contracts/${contractId}/compliance`);
  const { error, run } = useAction();
  const [file, setFile] = useState<File | null>(null);
  const d = r.data;
  return (
    <section className="card" aria-label="Insurance and compliance">
      <h2>Insurance and compliance</h2>
      {d && (d.requireInsurance || d.requireLienWaivers) && (
        <p className="notice">Payment requires {[d.requireInsurance && "current general liability and workers' compensation certificates", d.requireLienWaivers && "a lien waiver for each invoice"].filter(Boolean).join(" and ")}.</p>
      )}
      {manager && d && <Requirements contractId={contractId} initial={{ requireInsurance: d.requireInsurance, requireLienWaivers: d.requireLienWaivers }} onSaved={r.reload} run={run} />}
      <ErrorText error={r.error ?? error} />
      <DataTable rows={d?.documents ?? null} empty="No documents yet." caption="Compliance documents" columns={[
        { label: "Type", render: (x: any) => label(x.kind) },
        { label: "Carrier / policy", render: (x: any) => [x.carrier, x.policy_number].filter(Boolean).join(" · ") || "—" },
        { label: "Limit", render: (x: any) => (x.limit_amount ? <Money value={x.limit_amount} /> : "—") },
        { label: "Expires", render: (x: any) => <>{fmtDate(x.expires_on)}{x.expired && <span className="badge badge-rejected"> Expired</span>}{x.expiring && <span className="badge badge-pending"> Expiring</span>}</> },
        { label: "Files", render: (x: any) => x.files.length ? x.files.map((f: any) => <div key={f.id}><a href={`/api/files/${f.id}/download`}>{f.name}</a></div>) : "—" },
        { label: "Status", render: (x: any) => <Badge value={x.status} /> },
        { label: "", render: (x: any) => manager && x.status === "pending" && (
          <span className="row-actions">
            <ActionButton className="link" onClick={async () => { await api("PATCH", `/compliance-documents/${x.id}`, { status: "accepted" }); r.reload(); }}>Accept</ActionButton>
            <ActionButton className="link danger" onClick={async () => { await api("PATCH", `/compliance-documents/${x.id}`, { status: "rejected" }); r.reload(); }}>Reject</ActionButton>
          </span>
        ) },
      ]} />
      {canUpload && (
        <Form ariaLabel="Add compliance document" submitLabel="Add document" resetOnSuccess className="flat" initial={{ kind: "general_liability" }}
          fields={[
            { name: "kind", label: "Document", type: "select", required: true, options: DOC_KINDS },
            { name: "carrier", label: "Carrier" },
            { name: "policyNumber", label: "Policy #" },
            { name: "limitAmount", label: "Limit", type: "money" },
            { name: "effectiveOn", label: "Effective", type: "date" },
            { name: "expiresOn", label: "Expires", type: "date" },
          ]}
          onSubmit={async (v) => {
            const doc = await api("POST", `/contracts/${contractId}/compliance`, {
              kind: v.kind, carrier: v.carrier || null, policyNumber: v.policyNumber || null, limitAmount: v.limitAmount ? String(v.limitAmount).replace(/,/g, "") : null,
              effectiveOn: v.effectiveOn || null, expiresOn: v.expiresOn || null,
            });
            if (file) {
              const f = await upload(`/projects/${projectId}/files`, {}, file);
              await api("POST", "/attachments", { entityType: "compliance_document", entityId: doc.id, fileId: f.id });
              setFile(null);
            }
            r.reload();
          }}>
          <label className="span-all">Certificate (PDF) <input type="file" accept="application/pdf,image/*" aria-label="Certificate file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        </Form>
      )}
    </section>
  );
}

/** Invoice contacts and payment requirements on a commitment (project managers). */
export function ContractContacts({ contract, projectId }: { contract: any; projectId: string }) {
  const { members } = useMemberOptions(projectId);
  const [saved, setSaved] = useState<string | null>(null);
  const subs = members.filter((m) => m.role === "subcontractor");
  return (
    <section className="card" aria-label="Invoice contacts">
      <h2>Invoice contacts</h2>
      <p className="muted small">Subcontractor users who can see this commitment and submit their own pay applications.</p>
      {subs.length ? (
        <Form ariaLabel="Invoice contacts" submitLabel="Save contacts" className="flat" initial={{ userIds: contract.contacts?.map((c: any) => c.id) ?? [] }}
          fields={[{ name: "userIds", label: "Contacts (Ctrl/Cmd-click for several)", type: "multiselect", options: subs.map((m) => ({ value: m.id, label: `${m.name}${m.company ? ` (${m.company})` : ""}` })) }]}
          onSubmit={async (v) => { await api("PUT", `/contracts/${contract.id}/contacts`, { userIds: v.userIds ?? [] }); setSaved("Contacts saved"); }}>
          {saved && <span className="muted small" role="status">{saved}</span>}
        </Form>
      ) : <Empty>Invite the subcontractor to the project first.</Empty>}
    </section>
  );
}

/** Lien waivers on an invoice: contacts upload them, managers request, accept or reject. */
export function LienWaivers({ inv, waivers, isContact, manager, onChange }: { inv: any; waivers: any[]; isContact: boolean; manager: boolean; onChange: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  return (
    <section className="card" aria-label="Lien waivers">
      <h2>Lien waivers</h2>
      <DataTable rows={waivers} empty="No lien waivers yet." caption="Lien waivers" columns={[
        { label: "Type", render: (w: any) => label(w.kind) },
        { label: "Amount", render: (w: any) => <Money value={w.amount} /> },
        { label: "Through", render: (w: any) => fmtDate(w.through_date) },
        { label: "Status", render: (w: any) => <Badge value={w.status} /> },
        { label: "", render: (w: any) => manager && w.status === "received" && (
          <span className="row-actions">
            <ActionButton className="link" onClick={async () => { await api("POST", `/lien-waivers/${w.id}/status`, { status: "accepted" }); onChange(); }}>Accept</ActionButton>
            <ActionButton className="link danger" onClick={async () => { await api("POST", `/lien-waivers/${w.id}/status`, { status: "rejected" }); onChange(); }}>Reject</ActionButton>
          </span>
        ) },
      ]} />
      {(isContact || manager) && (
        <Form ariaLabel={isContact ? "Upload lien waiver" : "Request lien waiver"} submitLabel={isContact ? "Upload waiver" : "Request waiver"} resetOnSuccess className="flat" initial={{ kind: "conditional_progress" }}
          fields={[{ name: "kind", label: "Waiver type", type: "select", required: true, options: WAIVER_KINDS }]}
          onSubmit={async (v) => {
            const w = await api("POST", `/invoices/${inv.id}/lien-waivers`, { kind: v.kind, status: isContact ? "received" : "requested" });
            if (file) {
              const f = await upload(`/projects/${inv.project_id}/files`, {}, file);
              await api("POST", "/attachments", { entityType: "lien_waiver", entityId: w.id, fileId: f.id });
              setFile(null);
            }
            onChange();
          }}>
          {isContact && <label className="span-all">Signed waiver <input type="file" accept="application/pdf,image/*" aria-label="Waiver file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>}
        </Form>
      )}
    </section>
  );
}

/** The subcontractor's view: their commitments, pay applications and compliance on this project. */
export function MyContractsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/my-contracts`);
  const { error, run } = useAction();
  if (!list.data) return <ErrorText error={list.error} />;
  if (!list.data.length) return <><h2 className="tool-title">My contracts</h2><Empty>No commitments list you as an invoice contact yet. Ask the project manager to add you.</Empty></>;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toLocaleDateString("en-CA");
  return (
    <>
      <h2 className="tool-title">My contracts</h2>
      <ErrorText error={error} />
      {list.data.map((k) => (
        <div key={k.id}>
          <section className="card" aria-label={`Contract ${k.title}`}>
            <h2>#{k.number} {k.title} <Badge value={k.status} /></h2>
            <p className="muted">{label(k.kind)} · contract sum <Money value={k.contractSum} /> · retainage {k.retainage_percent}%</p>
            <DataTable rows={k.invoices} href={(i: any) => `/invoices/${i.id}`} empty="No pay applications yet." caption={`Pay applications for ${k.title}`} columns={[
              { label: "#", render: (i: any) => i.number },
              { label: "Period", render: (i: any) => `${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}` },
              { label: "Completed to date", render: (i: any) => <Money value={i.completed_to_date} /> },
              { label: "Payment due", render: (i: any) => <Money value={i.current_payment_due} /> },
              { label: "Status", render: (i: any) => <>{<Badge value={i.status} />}{i.status === "approved" && i.paymentBlockers.length > 0 && <div className="small danger">On hold: {i.paymentBlockers.join("; ")}</div>}</> },
            ]} />
            {k.status === "approved" && (
              <Form ariaLabel={`New pay application for ${k.title}`} submitLabel="Start pay application" className="flat" initial={{ periodStart: monthStart, periodEnd: today() }}
                fields={[{ name: "periodStart", label: "Period from", type: "date", required: true }, { name: "periodEnd", label: "Period to", type: "date", required: true }]}
                onSubmit={async (v) => run(async () => { const inv = await api("POST", `/contracts/${k.id}/invoices`, v); location.assign(`/invoices/${inv.id}`); })} />
            )}
          </section>
          <ComplianceSection contractId={k.id} projectId={project.id} manager={false} canUpload />
        </div>
      ))}
    </>
  );
}

