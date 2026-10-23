import { useState } from "react";
import { api, fmtDate, fmtDateTime, label } from "../../api";
import { Approvals, Attachments, Comments, CustomFields, canManage, canWrite, useMemberOptions } from "../../components/records";
import { ActionButton, Badge, Creator, DataTable, ErrorText, Form, KeyValues, Link, Loading, PageHead } from "../../components/ui";
import { useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

const impactOptions = ["tbd", "yes", "no"].map((v) => ({ value: v, label: v === "tbd" ? "TBD" : label(v) }));

// ---------------- RFIs ----------------

export function RfisTool({ project }: { project: ProjectInfo }) {
  const [status, setStatus] = useState("");
  const rfis = useApi<any[]>(`/projects/${project.id}/rfis${status ? `?status=${status}` : ""}`);
  const writable = canWrite(project.myRole);
  const { options } = useMemberOptions(writable ? project.id : null);
  const drawings = useApi<any[]>(writable ? `/projects/${project.id}/drawings` : null);
  const specs = useApi<any[]>(writable ? `/projects/${project.id}/specs` : null);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">RFIs</h2>
        {writable && (
          <Creator label="New RFI">
            {(close) => (
              <Form ariaLabel="New RFI" submitLabel="Create RFI" onCancel={close} initial={{ costImpact: "tbd", scheduleImpact: "tbd" }}
                fields={[
                  { name: "subject", label: "Subject", required: true, full: true },
                  { name: "question", label: "Question", type: "textarea", required: true },
                  { name: "assigneeId", label: "Ball in court", type: "select", options },
                  { name: "dueDate", label: "Response due", type: "date" },
                  { name: "drawingId", label: "Drawing", type: "select", options: (drawings.data ?? []).map((d) => ({ value: d.id, label: `${d.number} ${d.title}` })) },
                  { name: "specSectionId", label: "Spec section", type: "select", options: (specs.data ?? []).map((s) => ({ value: s.id, label: `${s.number} ${s.title}` })) },
                  { name: "costImpact", label: "Cost impact", type: "select", required: true, options: impactOptions },
                  { name: "scheduleImpact", label: "Schedule impact", type: "select", required: true, options: impactOptions },
                  { name: "draft", label: "Save as draft", type: "checkbox" },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/rfis`, { ...v, assigneeId: v.assigneeId || null, dueDate: v.dueDate || null, drawingId: v.drawingId || null, specSectionId: v.specSectionId || null });
                  close(); rfis.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <div className="filters">
        <label>Status <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["draft", "open", "answered", "closed"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label>
      </div>
      <section className="card">
        <ErrorText error={rfis.error} />
        <DataTable rows={rfis.data} href={(r) => `/rfis/${r.id}`} empty="No RFIs." caption="RFIs" columns={[
          { label: "#", render: (r) => r.number },
          { label: "Subject", render: (r) => r.subject },
          { label: "Status", render: (r) => <Badge value={r.status} /> },
          { label: "Ball in court", render: (r) => r.assignee_name ?? "—" },
          { label: "Due", render: (r) => <span className={r.overdue ? "overdue" : ""}>{fmtDate(r.due_date)}</span> },
          { label: "Sheet", render: (r) => r.drawing_number ?? "—" },
          { label: "Cost / schedule", render: (r) => `${label(r.cost_impact)} / ${label(r.schedule_impact)}` },
        ]} />
      </section>
    </>
  );
}

export function RfiPage({ id }: { id: string }) {
  const r = useApi(`/rfis/${id}`);
  const rfi = r.data;
  const { options } = useMemberOptions(rfi && canWrite(rfi.myRole) ? rfi.project_id : null);
  if (r.error) return <ErrorText error={r.error} />;
  if (!rfi) return <Loading />;
  const manager = canManage(rfi.myRole);
  const isAssignee = rfi.assignee_id === rfi.myId;
  const canRespond = (isAssignee || canWrite(rfi.myRole)) && ["open", "answered"].includes(rfi.status);
  const canOfficial = isAssignee || manager;
  const canClose = manager || (rfi.created_by === rfi.myId && canWrite(rfi.myRole));
  return (
    <>
      <PageHead pdf={`/rfis/${rfi.id}/pdf`} back={{ to: `/projects/${rfi.project_id}/rfis`, label: "RFIs" }} title={<>RFI #{rfi.number}: {rfi.subject} <Badge value={rfi.status} /></>}
        actions={canClose && (rfi.status === "closed"
          ? <ActionButton onClick={async () => { await api("POST", `/rfis/${rfi.id}/status`, { status: "open" }); r.reload(); }}>Reopen</ActionButton>
          : <ActionButton className="primary" onClick={async () => { await api("POST", `/rfis/${rfi.id}/status`, { status: "closed" }); r.reload(); }}>Close RFI</ActionButton>)} />
      <section className="card">
        <KeyValues items={[
          ["Ball in court", rfi.assignee_name],
          ["Due", <span className={rfi.status === "open" && rfi.due_date && rfi.due_date < new Date().toISOString() ? "overdue" : ""}>{fmtDate(rfi.due_date)}</span>],
          ["Created", `${fmtDateTime(rfi.created_at)} by ${rfi.created_by_name ?? "—"}`],
          ["Drawing", rfi.drawing_id ? <Link to={`/drawings/${rfi.drawing_id}`}>{rfi.drawing_number}</Link> : null],
          ["Spec section", rfi.spec_number ? `${rfi.spec_number} ${rfi.spec_title}` : null],
          ["Cost impact", label(rfi.cost_impact)],
          ["Schedule impact", label(rfi.schedule_impact)],
        ]} />
        <h2>Question</h2>
        <p className="pre">{rfi.question}</p>
      </section>
      {canWrite(rfi.myRole) && rfi.status !== "closed" && (
        <Form ariaLabel="Reassign RFI" submitLabel="Update" className="compact" initial={{ assigneeId: rfi.assignee_id ?? "", dueDate: rfi.due_date?.slice(0, 10) ?? "" }}
          fields={[{ name: "assigneeId", label: "Ball in court", type: "select", options }, { name: "dueDate", label: "Due", type: "date" }]}
          onSubmit={async (v) => { await api("PATCH", `/rfis/${rfi.id}`, { assigneeId: v.assigneeId || null, dueDate: v.dueDate || null, ...(rfi.status === "draft" ? { draft: false } : {}) }); r.reload(); }} />
      )}
      <section className="card" aria-label="Responses">
        <h2>Responses</h2>
        {rfi.responses.length ? (
          <ul className="list">
            {rfi.responses.map((x: any) => (
              <li key={x.id} className={x.is_official ? "official" : ""}>
                <strong>{x.author_name}</strong> {x.is_official && <span className="badge badge-approved">Official answer</span>} <span className="muted small">{fmtDateTime(x.created_at)}</span>
                <p className="pre">{x.body}</p>
              </li>
            ))}
          </ul>
        ) : <p className="empty">No responses yet.</p>}
        {canRespond && (
          <Form ariaLabel="Respond" submitLabel="Post response" resetOnSuccess className="flat"
            fields={[{ name: "body", label: "Response", type: "textarea", required: true }, ...(canOfficial ? [{ name: "official", label: "This is the official answer", type: "checkbox" as const }] : [])]}
            onSubmit={async (v) => { await api("POST", `/rfis/${rfi.id}/responses`, { body: v.body, official: !!v.official }); r.reload(); }} />
        )}
      </section>
      <Attachments entityType="rfi" entityId={rfi.id} projectId={rfi.project_id} files={rfi.attachments} onChange={r.reload} canAdd={canWrite(rfi.myRole) || isAssignee} />
      <CustomFields entityType="rfi" entityId={rfi.id} editable={canWrite(rfi.myRole)} />
      <Comments entityType="rfi" entityId={rfi.id} projectId={rfi.project_id} />
    </>
  );
}

// ---------------- Submittals ----------------

const typeOptions = ["shop_drawing", "product_data", "sample", "mockup", "other"].map((v) => ({ value: v, label: label(v) }));

export function SubmittalsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/submittals`);
  const writable = canWrite(project.myRole);
  const { options } = useMemberOptions(writable ? project.id : null);
  const specs = useApi<any[]>(writable ? `/projects/${project.id}/specs` : null);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Submittals</h2>
        {writable && (
          <Creator label="New submittal">
            {(close) => (
              <Form ariaLabel="New submittal" submitLabel="Create submittal" onCancel={close} initial={{ type: "shop_drawing" }}
                fields={[
                  { name: "title", label: "Title", required: true, full: true },
                  { name: "type", label: "Type", type: "select", required: true, options: typeOptions },
                  { name: "specSectionId", label: "Spec section", type: "select", options: (specs.data ?? []).map((s) => ({ value: s.id, label: `${s.number} ${s.title}` })) },
                  { name: "dueDate", label: "Required by", type: "date" },
                  { name: "reviewer1", label: "First reviewer", type: "select", options },
                  { name: "reviewer2", label: "Second reviewer", type: "select", options },
                  { name: "reviewer3", label: "Third reviewer", type: "select", options },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/submittals`, { title: v.title, type: v.type, specSectionId: v.specSectionId || null, dueDate: v.dueDate || null, reviewerIds: [v.reviewer1, v.reviewer2, v.reviewer3].filter(Boolean) });
                  close(); list.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(s) => `/submittals/${s.id}`} empty="No submittals." caption="Submittals" columns={[
          { label: "#", render: (s) => `${s.number}${s.revision ? `.${s.revision}` : ""}` },
          { label: "Title", render: (s) => s.title },
          { label: "Type", render: (s) => label(s.type) },
          { label: "Spec", render: (s) => s.spec_number ?? "—" },
          { label: "Status", render: (s) => <Badge value={s.status} /> },
          { label: "Ball in court", render: (s) => s.ball_in_court ?? "—" },
          { label: "Due", render: (s) => fmtDate(s.due_date) },
        ]} />
      </section>
    </>
  );
}

export function SubmittalPage({ id }: { id: string }) {
  const r = useApi(`/submittals/${id}`);
  const s = r.data;
  if (r.error) return <ErrorText error={r.error} />;
  if (!s) return <Loading />;
  const writable = canWrite(s.myRole);
  return (
    <>
      <PageHead pdf={`/submittals/${s.id}/pdf`} back={{ to: `/projects/${s.project_id}/submittals`, label: "Submittals" }}
        title={<>Submittal #{s.number}{s.revision ? ` rev ${s.revision}` : ""}: {s.title} <Badge value={s.status} /></>}
        actions={writable && (
          s.status === "draft" ? <ActionButton className="primary" onClick={async () => { await api("POST", `/submittals/${s.id}/submit`); r.reload(); }}>Submit for review</ActionButton>
          : ["revise_resubmit", "rejected"].includes(s.status) ? <ActionButton className="primary" onClick={async () => { const n = await api("POST", `/submittals/${s.id}/revise`); location.assign(`/submittals/${n.id}`); }}>Create revision {s.revision + 1}</ActionButton>
          : null)} />
      <section className="card">
        <KeyValues items={[
          ["Type", label(s.type)],
          ["Spec section", s.spec_number ? `${s.spec_number} ${s.spec_title}` : null],
          ["Required by", fmtDate(s.due_date)],
          ["Reviewers (in order)", s.reviewers.map((x: any) => x.name).join(" → ") || "None yet"],
          ["Created by", s.created_by_name],
          ["Revisions", s.revisions.map((x: any) => <span key={x.id}>{x.id === s.id ? <strong>rev {x.revision}</strong> : <Link to={`/submittals/${x.id}`}>rev {x.revision}</Link>} <Badge value={x.status} /> </span>)],
        ]} />
      </section>
      <Approvals steps={s.approvals} myId={s.myId} onDecided={r.reload} decisions={["approved", "approved_as_noted", "revise_resubmit", "rejected"]} />
      <Attachments entityType="submittal" entityId={s.id} projectId={s.project_id} files={s.attachments} onChange={r.reload} canAdd={writable} />
      <CustomFields entityType="submittal" entityId={s.id} editable={writable} />
      <Comments entityType="submittal" entityId={s.id} projectId={s.project_id} />
    </>
  );
}
