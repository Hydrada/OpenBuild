import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { Link } from "./components/ui";
import { AuditPage } from "./pages/Audit";
import { AuthPage } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { InvitePage } from "./pages/Invite";
import { ProjectPage } from "./pages/Project";
import { ProjectsPage } from "./pages/Projects";
import { TeamPage } from "./pages/Team";
import { match, navigate, usePath } from "./router";

const ORG_KEY = "openbuild.org";

export function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [allowSignup, setAllowSignup] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(localStorage.getItem(ORG_KEY));

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<Me>("GET", "/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        api("GET", "/auth/config").then((c) => setAllowSignup(c.allowSignup), () => {});
      } else throw e;
    }
  }, []);
  useEffect(() => void loadMe(), [loadMe]);

  const invite = match("/invite/:token", path);
  if (me === undefined) return <p className="muted pad">Loading…</p>;
  if (invite) return <InvitePage token={invite.token!} me={me} onJoined={loadMe} />;
  if (!me) return <AuthPage allowSignup={allowSignup} onAuthed={loadMe} />;

  const org = me.orgs.find((o) => o.id === orgId) ?? me.orgs[0];
  if (!org) return <p className="pad">Your account is not a member of any organization.</p>;
  const isAdmin = org.role === "owner" || org.role === "admin";

  function switchOrg(id: string) {
    localStorage.setItem(ORG_KEY, id);
    setOrgId(id);
    navigate("/");
  }
  async function logout() {
    await api("POST", "/auth/logout");
    setMe(null);
    navigate("/");
  }

  const project = match("/projects/:id", path);
  let page;
  if (project) page = <ProjectPage key={project.id} projectId={project.id!} />;
  else if (path === "/projects") page = <ProjectsPage orgId={org.id} canCreate={isAdmin} />;
  else if (path === "/team") page = <TeamPage orgId={org.id} myRole={org.role} />;
  else if (path === "/audit" && isAdmin) page = <AuditPage orgId={org.id} />;
  else page = <Dashboard key={org.id} orgId={org.id} />;

  const nav = [["/", "Dashboard"], ["/projects", "Projects"], ["/team", "Team"], ...(isAdmin ? [["/audit", "Audit log"]] : [])];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">OpenBuild</div>
        {me.orgs.length > 1 ? (
          <select aria-label="Organization" value={org.id} onChange={(e) => switchOrg(e.target.value)}>
            {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        ) : <div className="org-name">{org.name}</div>}
        <nav aria-label="Main">
          {nav.map(([to, label]) => (
            <Link key={to} to={to!} className={(to === "/" ? path === "/" : path.startsWith(to!)) ? "active" : ""}>{label}</Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="small">{me.user.name}</div>
          <div className="muted small">{me.user.email} · {org.role}</div>
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="content">{page}</main>
    </div>
  );
}
