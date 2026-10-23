import { useState } from "react";
import { api, today } from "../../api";
import { canManage, useMemberOptions } from "../../components/records";
import { Badge, Creator, DataTable, ErrorText, Form } from "../../components/ui";
import { useAction, useApi } from "../../hooks";

/** Company directory of field workers who do not sign in (shown on the Team page). */
export function WorkersDirectory({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const list = useApi<any[]>(`/orgs/${orgId}/workers`);
  const { error, run } = useAction();
  return (
    <section className="card" aria-label="Field workers">
      <h2>Field workers</h2>
      <p className="muted small">People whose time a foreman enters (they don't need an account).</p>
      {canEdit && (
        <Form ariaLabel="Add field worker" submitLabel="Add worker" resetOnSuccess className="flat"
          fields={[
            { name: "name", label: "Worker name", required: true },
            { name: "employeeNumber", label: "Employee #" },
            { name: "trade", label: "Trade" },
            { name: "company", label: "Employer" },
          ]}
          onSubmit={async (v) => {
            await api("POST", `/orgs/${orgId}/workers`, { name: v.name, employeeNumber: v.employeeNumber || null, trade: v.trade || null, company: v.company || null });
            list.reload();
          }} />
      )}
      <ErrorText error={list.error ?? error} />
      <DataTable rows={list.data} empty="No field workers yet." caption="Field workers" columns={[
        { label: "Name", render: (w) => w.name },
        { label: "Employee #", render: (w) => w.employee_number ?? "—" },
        { label: "Trade", render: (w) => w.trade ?? "—" },
        { label: "Employer", render: (w) => w.company ?? "—" },
        { label: "Status", render: (w) => <Badge value={w.active ? "active" : "inactive"} /> },
        { label: "", render: (w) => canEdit && <button type="button" className="link" onClick={() => run(async () => { await api("PATCH", `/workers/${w.id}`, { active: !w.active }); list.reload(); })}>{w.active ? "Deactivate" : "Reactivate"}</button> },
      ]} />
    </section>
  );
}

/** Crew setup (managers) and the foreman's daily crew timesheet, shown inside the Timesheets tool. */
export function CrewTime({ project, onSaved }: { project: { id: string; org_id: string; myRole: string }; onSaved: () => void }) {
  const crews = useApi<any[]>(`/projects/${project.id}/crews`);
  const workers = useApi<any[]>(canManage(project.myRole) ? `/orgs/${project.org_id}/workers` : null);
  const codes = useApi<any[]>(`/projects/${project.id}/cost-codes`);
  const me = useApi<{ user: { id: string } }>("/me");
  const { options } = useMemberOptions(project.id);
  const manager = canManage(project.myRole);
  const mine = (crews.data ?? []).filter((c) => manager || c.foreman_id === me.data?.user.id);
  const [crewId, setCrewId] = useState("");
  const crew = mine.find((c) => c.id === crewId) ?? mine[0];
  const [date, setDate] = useState(today());
  const [hours, setHours] = useState<Record<string, string>>({});
  const [code, setCode] = useState("");
  const [desc, setDesc] = useState("");
  const { error, run, busy } = useAction();
  const [saved, setSaved] = useState<string | null>(null);
  const activeMembers = (crew?.members ?? []).filter((m: any) => m.active);

  return (
    <>
      {crew && (
        <section className="card" aria-label="Crew timesheet">
          <h2>Crew timesheet</h2>
          <form onSubmit={(e) => {
            e.preventDefault();
            const entries = activeMembers.filter((m: any) => hours[m.id] && Number(hours[m.id]) > 0).map((m: any) => ({ workerId: m.id, hours: hours[m.id] }));
            run(async () => {
              const r = await api("POST", `/projects/${project.id}/timesheets/crew`, { crewId: crew.id, workDate: date, costCodeId: code || null, description: desc || null, entries });
              setSaved(`${r.created} entries sent for approval`); setHours({}); onSaved();
            });
          }}>
            <div className="row">
              {mine.length > 1 && <label>Crew <select value={crew.id} onChange={(e) => setCrewId(e.target.value)}>{mine.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
              <label>Date <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
              <label>Cost code <select value={code} onChange={(e) => setCode(e.target.value)}><option value="">—</option>{(codes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} {c.description}</option>)}</select></label>
              <label>Work done <input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
            </div>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">{crew.name} hours</caption>
                <thead><tr><th scope="col">Worker</th><th scope="col">Trade</th><th scope="col">Hours</th></tr></thead>
                <tbody>
                  {activeMembers.map((m: any) => (
                    <tr key={m.id}>
                      <td>{m.name}</td><td>{m.trade ?? "—"}</td>
                      <td><input aria-label={`Hours for ${m.name}`} inputMode="decimal" pattern="[0-9]{1,2}(\.[0-9]{1,2})?" size={5} value={hours[m.id] ?? ""} onChange={(e) => setHours({ ...hours, [m.id]: e.target.value })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" onClick={() => setHours(Object.fromEntries(activeMembers.map((m: any) => [m.id, "8"])))}>Everyone 8 h</button>{" "}
            <button className="primary" type="submit" disabled={busy}>Submit crew time</button>
            {saved && <span className="muted small" role="status"> {saved}</span>}
          </form>
          <ErrorText error={error} />
        </section>
      )}
      {manager && (
        <section className="card" aria-label="Crews">
          <h2>Crews</h2>
          <DataTable rows={crews.data} empty="No crews yet." caption="Crews" columns={[
            { label: "Crew", render: (c) => c.name },
            { label: "Foreman", render: (c) => c.foreman_name ?? "—" },
            { label: "Members", render: (c) => c.members.map((m: any) => m.name).join(", ") || "—" },
          ]} />
          <Creator label="New crew">
            {(close) => (
              <Form ariaLabel="New crew" submitLabel="Create crew" onCancel={close}
                fields={[
                  { name: "name", label: "Crew name", required: true },
                  { name: "foremanId", label: "Foreman", type: "select", options },
                  { name: "workerIds", label: "Workers (Ctrl/Cmd-click for several)", type: "multiselect", options: (workers.data ?? []).filter((w) => w.active).map((w) => ({ value: w.id, label: w.name })) },
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/crews`, { name: v.name, foremanId: v.foremanId || null, workerIds: v.workerIds ?? [] });
                  close(); crews.reload();
                }} />
            )}
          </Creator>
          <Creator label="Add worker on site">
            {(close) => (
              <Form ariaLabel="Add worker on site" submitLabel="Add worker" onCancel={close}
                fields={[{ name: "name", label: "Worker name", required: true }, { name: "employeeNumber", label: "Employee #" }, { name: "trade", label: "Trade" }]}
                onSubmit={async (v) => {
                  await api("POST", `/projects/${project.id}/workers`, { name: v.name, employeeNumber: v.employeeNumber || null, trade: v.trade || null });
                  close(); workers.reload();
                }} />
            )}
          </Creator>
          {(crews.data ?? []).map((c) => (
            <details key={c.id}>
              <summary>Edit {c.name}</summary>
              <Form ariaLabel={`Edit ${c.name}`} submitLabel="Save crew" className="flat" initial={{ foremanId: c.foreman_id ?? "", workerIds: c.members.map((m: any) => m.id) }}
                fields={[
                  { name: "foremanId", label: "Foreman", type: "select", options },
                  { name: "workerIds", label: "Workers", type: "multiselect", options: (workers.data ?? []).map((w) => ({ value: w.id, label: w.active ? w.name : `${w.name} (inactive)` })) },
                ]}
                onSubmit={async (v) => { await api("PATCH", `/crews/${c.id}`, { foremanId: v.foremanId || null, workerIds: v.workerIds ?? [] }); crews.reload(); }} />
            </details>
          ))}
        </section>
      )}
    </>
  );
}

