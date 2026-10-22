import { ErrorText } from "../components/ui";
import { useApi } from "../hooks";

export function AuditPage({ orgId }: { orgId: string }) {
  const { data, error } = useApi<any[]>(`/orgs/${orgId}/audit`);
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">Append-only record of every change, newest first.</p>
      <ErrorText error={error} />
      <section className="card">
        <table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {data?.map((a) => (
              <tr key={a.id}>
                <td className="nowrap">{new Date(a.created_at).toLocaleString()}</td>
                <td>{a.actor_name ?? "—"}</td>
                <td><code>{a.action}</code></td>
                <td><code className="small">{JSON.stringify(a.detail)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
