import { api, fmtDate, fmtDateTime, today } from "../../api";
import { Comments, canManage, canWrite, useMemberOptions } from "../../components/records";
import { ActionButton, Badge, Creator, DataTable, ErrorText, Form, Loading, PageHead } from "../../components/ui";
import { useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";
import { PayrollExport } from "./closeout";

export function MeetingsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/meetings`);
  const { members } = useMemberOptions(project.id);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Meetings</h2>
        {canWrite(project.myRole) && (
          <Creator label="New meeting">
            {(close) => (
              <Form ariaLabel="New meeting" submitLabel="Create meeting" onCancel={close} initial={{ startsAt: `${today()}T09:00` }}
                fields={[
                  { name: "title", label: "Title", required: true, placeholder: "OAC meeting #12" },
                  { name: "startsAt", label: "When", type: "datetime-local", required: true },
                  { name: "location", label: "Location" },
                  { name: "agenda", label: "Agenda (one topic per line)", type: "textarea" },
                ]}
                onSubmit={async (v) => {
                  const attendeeIds = [...document.querySelectorAll<HTMLInputElement>("input[name=attendee]:checked")].map((i) => i.value);
                  await api("POST", `/projects/${project.id}/meetings`, {
                    title: v.title, startsAt: new Date(v.startsAt).toISOString(), location: v.location || null, attendeeIds,
                    agenda: String(v.agenda).split("\n").map((s) => s.trim()).filter(Boolean),
                  });
                  close(); list.reload();
                }}>
                {members.length > 0 && (
                  <fieldset className="span-all attendees">
                    <legend>Attendees</legend>
                    {members.map((m) => <label key={m.id} className="check"><input type="checkbox" name="attendee" value={m.id} /> {m.name}</label>)}
                  </fieldset>
                )}
              </Form>
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(m) => `/meetings/${m.id}`} empty="No meetings yet." caption="Meetings" columns={[
          { label: "Title", render: (m) => m.title },
          { label: "When", render: (m) => fmtDateTime(m.starts_at) },
          { label: "Location", render: (m) => m.location ?? "—" },
          { label: "Open actions", render: (m) => m.open_actions },
          { label: "Status", render: (m) => <Badge value={m.status} /> },
        ]} />
      </section>
    </>
  );
}

export function MeetingPage({ id }: { id: string }) {
  const r = useApi(`/meetings/${id}`);
  const m = r.data;
  const { options } = useMemberOptions(m?.project_id);
  if (r.error) return <ErrorText error={r.error} />;
  if (!m) return <Loading />;
  const editable = canWrite(m.myRole) && m.status !== "minutes_published";
  return (
    <>
      <PageHead back={{ to: `/projects/${m.project_id}/meetings`, label: "Meetings" }} title={<>{m.title} <Badge value={m.status} /></>}
        sub={`${fmtDateTime(m.starts_at)}${m.location ? ` · ${m.location}` : ""} · attendees: ${m.attendees.map((a: any) => a.name).join(", ") || "none"}`}
        actions={editable && <ActionButton className="primary" confirm="Publish the minutes? Attendees and action owners are notified and the minutes lock." onClick={async () => { await api("POST", `/meetings/${m.id}/publish`); r.reload(); }}>Publish minutes</ActionButton>} />
      <section className="card" aria-label="Minutes">
        <h2>Minutes</h2>
        <DataTable rows={m.items} empty="No agenda items." caption="Minutes" columns={[
          { label: "#", render: (i: any) => i.seq },
          { label: "Topic", render: (i: any) => i.topic },
          { label: "Notes", render: (i: any) => editable
            ? <textarea aria-label={`Notes for ${i.topic}`} defaultValue={i.notes ?? ""} rows={2} onBlur={(e) => e.target.value !== (i.notes ?? "") && api("PATCH", `/meetings/${m.id}/items/${i.id}`, { notes: e.target.value || null }).then(r.reload)} />
            : <span className="pre">{i.notes ?? ""}</span> },
          { label: "Action owner", render: (i: any) => i.assignee_name ?? "—" },
          { label: "Due", render: (i: any) => fmtDate(i.due_date) },
          { label: "Status", render: (i: any) => i.assignee_id && canWrite(m.myRole)
            ? <select aria-label={`Status of ${i.topic}`} value={i.status} onChange={(e) => api("PATCH", `/meetings/${m.id}/items/${i.id}`, { status: e.target.value }).then(r.reload)}><option value="open">Open</option><option value="closed">Closed</option></select>
            : i.assignee_id ? <Badge value={i.status} /> : "—" },
        ]} />
      </section>
      {editable && (
        <Form ariaLabel="Add item" submitLabel="Add item" resetOnSuccess
          fields={[
            { name: "topic", label: "Topic / action", required: true, full: true },
            { name: "notes", label: "Notes", type: "textarea" },
            { name: "assigneeId", label: "Action owner", type: "select", options },
            { name: "dueDate", label: "Due", type: "date" },
          ]}
          onSubmit={async (v) => { await api("POST", `/meetings/${m.id}/items`, { topic: v.topic, notes: v.notes || null, assigneeId: v.assigneeId || null, dueDate: v.dueDate || null }); r.reload(); }} />
      )}
      <Comments entityType="meeting" entityId={m.id} projectId={m.project_id} />
    </>
  );
}

export function TimesheetsTool({ project }: { project: ProjectInfo }) {
  const t = useApi(`/projects/${project.id}/timesheets`);
  const codes = useApi<any[]>(canManage(project.myRole) || canWrite(project.myRole) ? `/projects/${project.id}/cost-codes` : null);
  const data = t.data;
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Timesheets</h2>
        <Creator label="Log time">
          {(close) => (
            <Form ariaLabel="Log time" submitLabel="Save time" onCancel={close} initial={{ workDate: today() }}
              fields={[
                { name: "workDate", label: "Date", type: "date", required: true },
                { name: "hours", label: "Hours", type: "number", step: "0.25", min: "0.25", max: "24", required: true },
                { name: "costCodeId", label: "Cost code", type: "select", options: (codes.data ?? []).map((c) => ({ value: c.id, label: `${c.code} ${c.description}` })) },
                { name: "description", label: "Work done" },
              ]}
              onSubmit={async (v) => { await api("POST", `/projects/${project.id}/timesheets`, { workDate: v.workDate, hours: String(v.hours), costCodeId: v.costCodeId || null, description: v.description || null }); close(); t.reload(); }} />
          )}
        </Creator>
      </div>
      <ErrorText error={t.error} />
      {data && <p className="muted">{data.canApprove ? "All entries" : "Your entries"} · approved {data.totals.approvedHours} h of {data.totals.allHours} h</p>}
      <section className="card">
        <DataTable rows={data?.entries ?? null} empty="No time logged." caption="Timesheet entries" columns={[
          { label: "Date", render: (e: any) => fmtDate(e.work_date) },
          { label: "Worker", render: (e: any) => e.worker_name },
          { label: "Hours", render: (e: any) => e.hours },
          { label: "Cost code", render: (e: any) => e.cost_code ?? "—" },
          { label: "Work", render: (e: any) => e.description ?? "" },
          { label: "Status", render: (e: any) => <Badge value={e.status} /> },
          { label: "", render: (e: any) => data?.canApprove && e.status === "submitted" && (
            <span className="row-actions">
              <ActionButton className="link" onClick={async () => { await api("POST", `/timesheets/${e.id}/decide`, { decision: "approved" }); t.reload(); }}>Approve</ActionButton>
              <ActionButton className="link danger" onClick={async () => { await api("POST", `/timesheets/${e.id}/decide`, { decision: "rejected" }); t.reload(); }}>Reject</ActionButton>
            </span>
          ) },
        ]} />
      </section>
      {data?.canApprove && <PayrollExport projectId={project.id} />}
    </>
  );
}
