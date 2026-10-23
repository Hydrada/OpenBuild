import { api, fmtDate, fmtDateTime } from "../api";
import { ActionButton, Badge, Creator, DataTable, ErrorText, Form, Money, PageHead } from "../components/ui";
import { useApi } from "../hooks";

/** Company-wide bidder directory with prequalification review. */
export function BiddersPage({ orgId, canReview }: { orgId: string; canReview: boolean }) {
  const list = useApi<any[]>(`/orgs/${orgId}/bidder-companies`);
  const decide = (id: string, status: string) => async () => { await api("POST", `/orgs/${orgId}/bidder-companies/${id}/prequal`, { status }); list.reload(); };
  return (
    <>
      <PageHead title="Bidder directory" sub="Subcontractors and suppliers you invite to bid. Only prequalified companies can be invited from the directory."
        actions={canReview && (
          <Creator label="Add company">
            {(close) => (
              <Form ariaLabel="Add bidder company" submitLabel="Add company" onCancel={close}
                fields={[
                  { name: "name", label: "Company", required: true },
                  { name: "trade", label: "Trade", placeholder: "Painting" },
                  { name: "email", label: "Estimating email", type: "email", required: true },
                  { name: "bondingLimit", label: "Bonding limit", type: "money" },
                  { name: "insuranceExpires", label: "Insurance expires", type: "date" },
                  { name: "emr", label: "EMR (safety rating)", placeholder: "0.85" },
                  { name: "notes", label: "Notes", type: "textarea" },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/orgs/${orgId}/bidder-companies`, { name: v.name, trade: v.trade || null, email: v.email, bondingLimit: v.bondingLimit || null, insuranceExpires: v.insuranceExpires || null, emr: v.emr || null, notes: v.notes || null });
                  close(); list.reload();
                }} />
            )}
          </Creator>
        )} />
      <ErrorText error={list.error} />
      <section className="card">
        <DataTable rows={list.data} empty="No companies yet." caption="Bidder companies" columns={[
          { label: "Company", render: (c) => c.name },
          { label: "Trade", render: (c) => c.trade ?? "—" },
          { label: "Email", render: (c) => c.email },
          { label: "Bonding", render: (c) => <Money value={c.bonding_limit} /> },
          { label: "Insurance", render: (c) => <span className={c.insurance_expired ? "overdue" : ""}>{fmtDate(c.insurance_expires)}</span> },
          { label: "EMR", render: (c) => c.emr ?? "—" },
          { label: "Prequalification", render: (c) => <><Badge value={c.prequal_status} />{c.reviewed_at && <div className="muted small">{c.reviewed_by_name} · {fmtDateTime(c.reviewed_at)}</div>}</> },
          { label: "", render: (c) => canReview && (
            <span className="row-actions">
              {c.prequal_status !== "approved" && <ActionButton className="link" onClick={decide(c.id, "approved")}>Approve</ActionButton>}
              {c.prequal_status !== "rejected" && <ActionButton className="link danger" onClick={decide(c.id, "rejected")}>Reject</ActionButton>}
            </span>
          ) },
        ]} />
      </section>
    </>
  );
}
