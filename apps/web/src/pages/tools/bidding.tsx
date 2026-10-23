import { useState } from "react";
import { api, fmtDateTime } from "../../api";
import { canManage } from "../../components/records";
import { ActionButton, Badge, Creator, DataTable, ErrorText, Form, KeyValues, Link, Loading, Money, PageHead } from "../../components/ui";
import { useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

export function BiddingTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/bid-packages`);
  const codes = useApi<any[]>(`/projects/${project.id}/cost-codes`);
  const week = new Date(Date.now() + 7 * 86_400_000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Bidding</h2>
        {canManage(project.myRole) && (
          <Creator label="New bid package">
            {(close) => (
              <Form ariaLabel="New bid package" submitLabel="Create package" onCancel={close} initial={{ dueAt: week }}
                fields={[
                  { name: "title", label: "Package title", required: true, placeholder: "Interior painting" },
                  { name: "costCodeId", label: "Cost code (for the awarded subcontract)", type: "select", options: (codes.data ?? []).map((c) => ({ value: c.id, label: `${c.code} ${c.description}` })) },
                  { name: "dueAt", label: "Bids due", type: "datetime-local", required: true },
                  { name: "scope", label: "Scope of work", type: "textarea" },
                ]}
                onSubmit={async (v) => { await api("POST", `/projects/${project.id}/bid-packages`, { title: v.title, costCodeId: v.costCodeId || null, dueAt: new Date(v.dueAt).toISOString(), scope: v.scope || null }); close(); list.reload(); }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(b) => `/bid-packages/${b.id}`} empty="No bid packages." caption="Bid packages" columns={[
          { label: "#", render: (b) => b.number },
          { label: "Package", render: (b) => b.title },
          { label: "Due", render: (b) => fmtDateTime(b.due_at) },
          { label: "Bids", render: (b) => `${b.submitted} of ${b.invited}` },
          { label: "Low bid", render: (b) => <Money value={b.low_bid} /> },
          { label: "Status", render: (b) => <Badge value={b.status} /> },
        ]} />
      </section>
    </>
  );
}

export function BidPackagePage({ id }: { id: string }) {
  const r = useApi(`/bid-packages/${id}`);
  const [link, setLink] = useState<string | null>(null);
  const b = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!b) return <Loading />;
  const manage = canManage(b.myRole);
  return (
    <>
      <PageHead back={{ to: `/projects/${b.project_id}/bidding`, label: "Bidding" }} title={<>Bid package #{b.number}: {b.title} <Badge value={b.status} /></>}
        sub={`Due ${fmtDateTime(b.due_at)}${b.cost_code ? ` · cost code ${b.cost_code}` : ""}`}
        actions={manage && b.status !== "awarded" && (
          b.status === "open"
            ? <ActionButton onClick={async () => { await api("POST", `/bid-packages/${b.id}/status`, { status: "closed" }); r.reload(); }}>Close bidding</ActionButton>
            : <ActionButton onClick={async () => { await api("POST", `/bid-packages/${b.id}/status`, { status: "open" }); r.reload(); }}>Reopen bidding</ActionButton>
        )} />
      {b.scope && <section className="card"><h2>Scope</h2><p className="pre">{b.scope}</p></section>}
      {b.contract_id && <p className="notice">Awarded — <Link to={`/contracts/${b.contract_id}`}>subcontract #{b.contract_number}</Link> created as a draft for review and approval.</p>}
      <section className="card" aria-label="Bid leveling">
        <h2>Bid leveling {b.low_bid && <span className="muted small">low bid <Money value={b.low_bid} /></span>}</h2>
        <DataTable rows={b.bidders} empty="No bidders invited yet." caption="Bidders" columns={[
          { label: "Company", render: (x: any) => x.company },
          { label: "Status", render: (x: any) => <Badge value={x.status} /> },
          { label: "Bid", render: (x: any) => <Money value={x.amount} /> },
          { label: "Over low", render: (x: any) => x.over_low === null ? "—" : <><Money value={x.over_low} /> <span className="muted small">({x.over_low_percent}%)</span></> },
          { label: "Notes", render: (x: any) => x.notes ?? "" },
          { label: "Submitted", render: (x: any) => fmtDateTime(x.submitted_at) },
          { label: "", render: (x: any) => manage && b.status !== "awarded" && x.status === "submitted" && (
            <ActionButton className="primary" confirm={`Award to ${x.company} and create a draft subcontract?`} onClick={async () => { await api("POST", `/bid-packages/${b.id}/award`, { bidderId: x.id }); r.reload(); }}>Award</ActionButton>
          ) },
        ]} />
      </section>
      {manage && b.status === "open" && (
        <Form ariaLabel="Invite bidder" submitLabel="Invite bidder" resetOnSuccess
          fields={[{ name: "company", label: "Company", required: true }, { name: "email", label: "Estimator email", type: "email", required: true }]}
          onSubmit={async (v) => { const res = await api("POST", `/bid-packages/${b.id}/bidders`, v); setLink(`${location.origin}${res.bidPath}`); r.reload(); }}>
          {link && <div className="span-all notice" role="status">Send this private bid link (no account needed):<input readOnly aria-label="Bid link" value={link} onFocus={(e) => e.target.select()} /></div>}
        </Form>
      )}
    </>
  );
}

/** Public page for invited bidders; reached by token link without signing in. */
export function BidPage({ token }: { token: string }) {
  const r = useApi(`/bids/${encodeURIComponent(token)}`);
  const [done, setDone] = useState<string | null>(null);
  const x = r.data;
  return (
    <main className="auth">
      <div className="auth-card wide">
        <h1 className="brand">OpenBuild</h1>
        <ErrorText error={r.error} />
        {x && (
          <>
            <h2>Bid: {x.title}</h2>
            <KeyValues items={[["Invited by", x.organization], ["Project", x.project], ["Bidder", x.company], ["Due", fmtDateTime(x.dueAt)], ["Your current bid", x.status === "submitted" ? <Money value={x.amount} /> : x.status === "declined" ? "Declined" : "Not submitted"]]} />
            {x.scope && <section className="card"><h2>Scope</h2><p className="pre">{x.scope}</p></section>}
            {done && <p className="notice" role="status">{done}</p>}
            {x.open ? (
              <>
                <Form ariaLabel="Submit bid" submitLabel={x.status === "submitted" ? "Revise bid" : "Submit bid"} initial={{ amount: x.amount ?? "", notes: x.notes ?? "" }}
                  fields={[{ name: "amount", label: "Lump-sum amount (USD)", type: "money", required: true }, { name: "notes", label: "Inclusions / exclusions", type: "textarea" }]}
                  onSubmit={async (v) => { await api("POST", `/bids/${encodeURIComponent(token)}`, { amount: v.amount, notes: v.notes || null }); setDone("Thank you — your bid was received."); r.reload(); }} />
                <ActionButton className="link danger" confirm="Decline to bid on this package?" onClick={async () => { await api("POST", `/bids/${encodeURIComponent(token)}`, { decline: true }); setDone("You declined this invitation."); r.reload(); }}>Decline to bid</ActionButton>
              </>
            ) : <p className="notice">Bidding on this package is closed.</p>}
          </>
        )}
      </div>
    </main>
  );
}
