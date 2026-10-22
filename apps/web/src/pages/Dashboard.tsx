import { fmtDate } from "../api";
import { Badge, Empty, ErrorText, Link } from "../components/ui";
import { useApi } from "../hooks";

export function Dashboard({ orgId }: { orgId: string }) {
  const { data, error } = useApi(`/orgs/${orgId}/dashboard`);
  if (error) return <ErrorText error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const totalProjects = data.projectsByStatus.reduce((n: number, s: { count: number }) => n + s.count, 0);
  const count = (s: string) => data.projectsByStatus.find((x: { status: string }) => x.status === s)?.count ?? 0;

  return (
    <>
      <h1>Dashboard</h1>
      <section className="stats" aria-label="Summary">
        <Stat label="Projects" value={totalProjects} sub={`${count("active")} active · ${count("bidding")} bidding`} />
        <Stat label="Open tasks" value={data.tasks.open} />
        <Stat label="Overdue" value={data.tasks.overdue} tone={data.tasks.overdue ? "warn" : undefined} />
        <Stat label="Completed tasks" value={data.tasks.done} />
      </section>
      <div className="grid-2">
        <section className="card">
          <h2>My open tasks</h2>
          {data.myTasks.length === 0 ? <Empty>Nothing assigned to you.</Empty> : (
            <ul className="list">
              {data.myTasks.map((t: any) => (
                <li key={t.id}>
                  <Link to={`/projects/${t.project_id}`}>{t.title}</Link>
                  <span className="muted"> · {t.project_name} · due {fmtDate(t.due_date)}</span> <Badge value={t.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>Recent activity</h2>
          <ActivityList items={data.activity} />
        </section>
      </div>
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone?: "warn" }) {
  return (
    <div className={`card stat ${tone ?? ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

const VERB: Record<string, string> = {
  "org.create": "created the organization",
  "project.create": "created project",
  "project.update": "updated project",
  "task.create": "added task",
  "task.update": "updated task",
  "invitation.create": "invited",
  "invitation.accept": "joined",
  "member.role_change": "changed a member's role",
  "project_member.set": "set a project member's role",
  "project_member.remove": "removed a project member",
};

export function ActivityList({ items }: { items: any[] }) {
  if (!items.length) return <Empty>No activity yet.</Empty>;
  return (
    <ul className="list activity">
      {items.map((a) => (
        <li key={a.id}>
          <strong>{a.actor_name ?? "Someone"}</strong> {VERB[a.action] ?? a.action}{" "}
          {a.detail?.title ?? a.detail?.name ?? a.detail?.email ?? ""}
          {a.project_name && <span className="muted"> · {a.project_name}</span>}
          <span className="muted small"> · {new Date(a.created_at).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
