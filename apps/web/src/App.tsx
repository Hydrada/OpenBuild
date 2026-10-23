import { useCallback, useEffect, useState, type JSX } from "react";
import { api, ApiError, type Me } from "./api";
import { Link } from "./components/ui";
import { useOutbox } from "./offline";
import { AuditPage } from "./pages/Audit";
import { AuthPage } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { InvitePage } from "./pages/Invite";
import { AccountPage, MyWorkPage, NotificationsPage, OrgSettingsPage, ResetPasswordPage } from "./pages/Me";
import { ProjectPage } from "./pages/Project";
import { ProjectsPage } from "./pages/Projects";
import { TeamPage } from "./pages/Team";
import { DocumentPage, DrawingPage } from "./pages/tools/docs";
import { DailyLogPage, IncidentPage, InspectionPage, ObservationPage, PunchPage } from "./pages/tools/field";
import { ChangeEventPage, ChangeOrderPage, ContractPage, InvoicePage } from "./pages/tools/financials";
import { BidPackagePage, BidPage } from "./pages/tools/bidding";
import { MeetingPage } from "./pages/tools/meetings";
import { ModelPage } from "./pages/tools/models";
import { RfiPage, SubmittalPage } from "./pages/tools/rfis";
import { match, navigate, usePath } from "./router";

const ORG_KEY = "openbuild.org";

/** Record detail routes; underscore variants come from notification links. */
const DETAIL: [string, (id: string) => JSX.Element][] = [
  ["rfis", (id) => <RfiPage id={id} />],
  ["submittals", (id) => <SubmittalPage id={id} />],
  ["drawings", (id) => <DrawingPage id={id} />],
  ["documents", (id) => <DocumentPage id={id} />],
  ["daily-logs", (id) => <DailyLogPage id={id} />],
  ["inspections", (id) => <InspectionPage id={id} />],
  ["punch", (id) => <PunchPage id={id} />],
  ["observations", (id) => <ObservationPage id={id} />],
  ["incidents", (id) => <IncidentPage id={id} />],
  ["contracts", (id) => <ContractPage id={id} />],
  ["change-events", (id) => <ChangeEventPage id={id} />],
  ["change-orders", (id) => <ChangeOrderPage id={id} />],
  ["invoices", (id) => <InvoicePage id={id} />],
  ["meetings", (id) => <MeetingPage id={id} />],
  ["bid-packages", (id) => <BidPackagePage id={id} />],
  ["models", (id) => <ModelPage id={id} />],
];

export function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [allowSignup, setAllowSignup] = useState(false);
  const [sso, setSso] = useState<{ name: string } | null>(null);
  const [orgId, setOrgId] = useState<string | null>(localStorage.getItem(ORG_KEY));
  const [unread, setUnread] = useState(0);
  const { items: outbox, online, photos } = useOutbox();
  const waiting = outbox.length + photos;

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<Me>("GET", "/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        api("GET", "/auth/config").then((c) => { setAllowSignup(c.allowSignup); setSso(c.sso); }, () => {});
      } else {
        throw e;
      }
    }
  }, []);
  useEffect(() => void loadMe(), [loadMe]);

  const loadUnread = useCallback(() => {
    api("GET", "/me/notifications?unread=1").then((n) => setUnread(n.unread), () => {});
  }, []);
  useEffect(() => {
    if (!me) return;
    loadUnread();
    const t = setInterval(loadUnread, 60_000);
    return () => clearInterval(t);
  }, [me, path, loadUnread]);

  useEffect(() => {
    // Keep keyboard and screen-reader focus sensible after client-side navigation.
    document.querySelector<HTMLElement>("main h1, main")?.focus?.();
  }, [path]);

  const invite = match("/invite/:token", path);
  const reset = match("/reset/:token", path);
  if (reset) return <ResetPasswordPage token={reset.token!} />;
  const bid = match("/bid/:token", path);
  if (bid) return <BidPage token={bid.token!} />;
  if (me === undefined) return <p className="muted pad">Loading…</p>;
  if (invite) return <InvitePage token={invite.token!} me={me} onJoined={loadMe} />;
  if (!me) return <AuthPage allowSignup={allowSignup} sso={sso} onAuthed={loadMe} />;

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

  let page: JSX.Element;
  const project = match("/projects/:id", path) ?? match("/projects/:id/:tool", path);
  const detail = DETAIL.map(([prefix, render]) => {
    const variants = [prefix, prefix.replace(/-/g, "_"), ...(prefix === "punch" ? ["punch_items", "punch-items"] : [])];
    for (const v of variants) {
      const m = match(`/${v}/:id`, path);
      if (m) return render(m.id!);
    }
    return null;
  }).find(Boolean);
  if (detail) page = detail;
  else if (project) page = <ProjectPage key={project.id} projectId={project.id!} tool={project.tool ?? "home"} />;
  else if (path === "/projects") page = <ProjectsPage orgId={org.id} canCreate={isAdmin} />;
  else if (path === "/team") page = <TeamPage orgId={org.id} myRole={org.role} myId={me.user.id} />;
  else if (path === "/audit" && isAdmin) page = <AuditPage orgId={org.id} />;
  else if (path === "/settings" && isAdmin) page = <OrgSettingsPage orgId={org.id} />;
  else if (path === "/notifications") page = <NotificationsPage onRead={loadUnread} />;
  else if (path === "/my-work") page = <MyWorkPage />;
  else if (path === "/account") page = <AccountPage me={me} onChange={loadMe} />;
  else page = <Dashboard key={org.id} orgId={org.id} />;

  const nav: [string, string][] = [
    ["/", "Dashboard"], ["/my-work", "My work"], ["/projects", "Projects"], ["/team", "Team"],
    ...(isAdmin ? ([["/audit", "Audit log"], ["/settings", "Settings"]] as [string, string][]) : []),
  ];
  const active = (to: string) => (to === "/" ? path === "/" : path.startsWith(to));

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="brand">OpenBuild</div>
        {me.orgs.length > 1 ? (
          <select aria-label="Organization" value={org.id} onChange={(e) => switchOrg(e.target.value)}>
            {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        ) : <div className="org-name">{org.name}</div>}
        <nav aria-label="Main">
          {nav.map(([to, text]) => <Link key={to} to={to} className={active(to) ? "active" : ""}>{text}</Link>)}
          <Link to="/notifications" className={active("/notifications") ? "active" : ""}>
            Notifications{unread > 0 && <span className="count" aria-label={`${unread} unread`}>{unread}</span>}
          </Link>
        </nav>
        {(!online || waiting > 0) && (
          <Link to="/my-work" className="sync-status">{online ? `${waiting} waiting to sync` : `Offline${waiting ? ` · ${waiting} queued` : ""}`}</Link>
        )}
        <div className="sidebar-foot">
          <Link to="/account" className="small">{me.user.name}</Link>
          <div className="muted small">{me.user.email} · {org.role}</div>
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="content" id="main" tabIndex={-1}>{page}</main>
    </div>
  );
}
