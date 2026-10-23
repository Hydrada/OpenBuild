import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";
import { projectRoleAllows } from "../src/lib/permissions.js";
import { hashPassword, verifyPassword } from "../src/lib/security.js";

let app: App;
let db: Db;

beforeEach(async () => {
  ({ app, db } = await makeApp());
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("auth", () => {
  it("registers, reads /me, logs out and back in", async () => {
    const { client } = await registerOwner(app);
    const me = await client.get("/api/me");
    expect(me.body.user.email).toBe("owner@example.com");
    expect(me.body.orgs[0]).toMatchObject({ name: "Acme Builders", role: "owner" });

    await client.post("/api/auth/logout");
    expect((await client.get("/api/me")).status).toBe(401);

    expect((await client.post("/api/auth/login", { email: "owner@example.com", password: "wrong password!" })).status).toBe(401);
    expect((await client.post("/api/auth/login", { email: "OWNER@example.com", password: "correct horse battery" })).status).toBe(200);
    expect((await client.get("/api/me")).status).toBe(200);
  });

  it("rejects duplicate emails, short passwords and disabled signup", async () => {
    await registerOwner(app);
    const c = new Client(app);
    expect((await c.post("/api/auth/register", { email: "Owner@Example.com", password: "long enough pw", name: "X", orgName: "Y" })).status).toBe(409);
    expect((await c.post("/api/auth/register", { email: "new@example.com", password: "short", name: "X", orgName: "Y" })).status).toBe(400);

    const closed = await makeApp({ allowSignup: false });
    const r = await new Client(closed.app).post("/api/auth/register", { email: "a@b.co", password: "long enough pw", name: "X", orgName: "Y" });
    expect(r.status).toBe(403);
    await closed.app.close();
    await closed.db.close();
  });

  it("requires the CSRF header on mutating API requests", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@b.co", password: "x" } });
    expect(res.statusCode).toBe(403);
  });

  it("rate-limits repeated failed logins", async () => {
    await registerOwner(app);
    const c = new Client(app);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await c.post("/api/auth/login", { email: "owner@example.com", password: "nope nope nope" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[11]).toBe(429);
  });

  it("stores passwords as salted scrypt, never plaintext", async () => {
    await registerOwner(app);
    const [u] = await db.query<{ password_hash: string }>("SELECT password_hash FROM users");
    expect(u!.password_hash).toMatch(/^scrypt\$/);
    expect(u!.password_hash).not.toContain("correct horse");
    const h = await hashPassword("abc");
    expect(await verifyPassword("abc", h)).toBe(true);
    expect(await verifyPassword("abd", h)).toBe(false);
  });
});

describe("organizations, projects and roles", () => {
  it("owner creates projects; members see only projects they belong to", async () => {
    const { client: owner, orgId } = await registerOwner(app);
    const p1 = await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower", code: "HT-01", status: "active" });
    const p2 = await owner.post(`/api/orgs/${orgId}/projects`, { name: "Elm Street Clinic", status: "bidding" });
    expect(p1.status).toBe(201);

    const { client: sub } = await inviteAndJoin(app, owner, orgId, "sub@example.com", { projectId: p1.body.id, projectRole: "viewer" });
    const visible = await sub.get(`/api/orgs/${orgId}/projects`);
    expect(visible.body.map((p: { name: string }) => p.name)).toEqual(["Harbor Tower"]);
    expect((await sub.get(`/api/projects/${p2.body.id}`)).status).toBe(404);
    expect((await sub.get(`/api/projects/${p1.body.id}`)).body.myRole).toBe("viewer");
  });

  it("enforces role restrictions on writes", async () => {
    const { client: owner, orgId } = await registerOwner(app);
    const p = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body;

    const { client: viewer } = await inviteAndJoin(app, owner, orgId, "viewer@example.com", { projectId: p.id, projectRole: "viewer" });
    const { client: contrib, userId: contribId } = await inviteAndJoin(app, owner, orgId, "contrib@example.com", { projectId: p.id, projectRole: "contributor" });
    const { client: manager } = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId: p.id, projectRole: "manager" });

    // Viewer: read only
    expect((await viewer.post(`/api/projects/${p.id}/tasks`, { title: "Pour slab" })).status).toBe(403);
    expect((await viewer.patch(`/api/projects/${p.id}`, { name: "Hacked" })).status).toBe(403);
    // Contributor: tasks yes, project settings no
    const task = await contrib.post(`/api/projects/${p.id}/tasks`, { title: "Pour slab", assigneeId: contribId, dueDate: "2026-11-01" });
    expect(task.status).toBe(201);
    expect((await contrib.patch(`/api/projects/${p.id}`, { name: "Hacked" })).status).toBe(403);
    // Manager: project settings yes, creating projects no (org-level)
    expect((await manager.patch(`/api/projects/${p.id}`, { status: "on_hold" })).body.status).toBe("on_hold");
    expect((await manager.post(`/api/orgs/${orgId}/projects`, { name: "Nope" })).status).toBe(403);
    // Members cannot invite or read the org audit log
    expect((await manager.post(`/api/orgs/${orgId}/invitations`, { email: "x@example.com" })).status).toBe(403);
    expect((await manager.get(`/api/orgs/${orgId}/audit`)).status).toBe(403);
    // Viewer can still update nothing on tasks
    expect((await viewer.patch(`/api/tasks/${task.body.id}`, { status: "done" })).status).toBe(403);
    expect((await contrib.patch(`/api/tasks/${task.body.id}`, { status: "done" })).body.status).toBe("done");
  });

  it("isolates organizations from each other", async () => {
    const a = await registerOwner(app, "a@example.com");
    const b = await registerOwner(app, "b@example.com");
    const pa = (await a.client.post(`/api/orgs/${a.orgId}/projects`, { name: "A secret" })).body;
    expect((await b.client.get(`/api/projects/${pa.id}`)).status).toBe(404);
    expect((await b.client.get(`/api/orgs/${a.orgId}/projects`)).status).toBe(404);
    expect((await b.client.post(`/api/projects/${pa.id}/tasks`, { title: "x" })).status).toBe(404);
    expect((await b.client.get(`/api/orgs/not-a-uuid/projects`)).status).toBe(404);
  });

  it("refuses to assign tasks to people outside the project", async () => {
    const { client: owner, orgId } = await registerOwner(app);
    const p = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "P" })).body;
    const outsider = await registerOwner(app, "outsider@example.com");
    const r = await owner.post(`/api/projects/${p.id}/tasks`, { title: "t", assigneeId: outsider.userId });
    expect(r.status).toBe(400);
  });

  it("only the owner may grant admin", async () => {
    const { client: owner, orgId } = await registerOwner(app);
    const { client: admin, userId: adminId } = await inviteAndJoin(app, owner, orgId, "admin@example.com", { orgRole: "admin" });
    const { userId: memberId } = await inviteAndJoin(app, owner, orgId, "m@example.com");
    expect((await admin.patch(`/api/orgs/${orgId}/members/${memberId}`, { role: "admin" })).status).toBe(403);
    expect((await admin.post(`/api/orgs/${orgId}/invitations`, { email: "x@example.com", orgRole: "admin" })).status).toBe(403);
    expect((await owner.patch(`/api/orgs/${orgId}/members/${memberId}`, { role: "admin" })).status).toBe(200);
    expect((await owner.patch(`/api/orgs/${orgId}/members/${adminId}`, { role: "member" })).status).toBe(200);
  });

  it("validates input", async () => {
    const { client: owner, orgId } = await registerOwner(app);
    expect((await owner.post(`/api/orgs/${orgId}/projects`, { name: "" })).status).toBe(400);
    expect((await owner.post(`/api/orgs/${orgId}/projects`, { name: "x", status: "bogus" })).status).toBe(400);
    expect((await owner.post(`/api/orgs/${orgId}/projects`, { name: "x", startDate: "2026-05-01", endDate: "2026-01-01" })).status).toBe(400);
  });

  it("role matrix", () => {
    expect(projectRoleAllows("viewer", "read")).toBe(true);
    expect(projectRoleAllows("viewer", "task.write")).toBe(false);
    expect(projectRoleAllows("contributor", "project.manage")).toBe(false);
    expect(projectRoleAllows("manager", "project.manage")).toBe(true);
    expect(projectRoleAllows(null, "read")).toBe(false);
  });
});

describe("invitations", () => {
  it("is single-use", async () => {
    const { client: owner, orgId } = await registerOwner(app);
    const { token } = await inviteAndJoin(app, owner, orgId, "once@example.com");
    expect((await new Client(app).post(`/api/invitations/${token}/accept`, { name: "x", password: "another long password" })).status).toBe(410);
    expect((await new Client(app).get(`/api/invitations/garbage`)).status).toBe(404);
  });

  it("existing accounts must be signed in as the invited email", async () => {
    const { client: ownerA, orgId: orgA } = await registerOwner(app, "a@example.com");
    const b = await registerOwner(app, "b@example.com");
    const inv = await ownerA.post(`/api/orgs/${orgA}/invitations`, { email: "b@example.com" });
    const token = inv.body.acceptPath.split("/").pop();
    expect((await new Client(app).post(`/api/invitations/${token}/accept`)).status).toBe(401);
    expect((await ownerA.post(`/api/invitations/${token}/accept`)).status).toBe(403);
    expect((await b.client.post(`/api/invitations/${token}/accept`)).status).toBe(200);
    const me = await b.client.get("/api/me");
    expect(me.body.orgs).toHaveLength(2);
  });

  it("stores only a hash of the invite token", async () => {
    const { client: owner, orgId } = await registerOwner(app);
    const inv = await owner.post(`/api/orgs/${orgId}/invitations`, { email: "h@example.com" });
    const token = inv.body.acceptPath.split("/").pop();
    const rows = await db.query<{ token_hash: string }>("SELECT token_hash FROM invitations");
    expect(rows[0]!.token_hash).not.toBe(token);
  });
});

describe("dashboard and audit", () => {
  it("summarizes projects and tasks and records an audit trail", async () => {
    const { client: owner, orgId, userId } = await registerOwner(app);
    const p = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body;
    await owner.post(`/api/projects/${p.id}/tasks`, { title: "Overdue", assigneeId: userId, dueDate: "2020-01-01" });
    await owner.post(`/api/projects/${p.id}/tasks`, { title: "Done", status: "done" });

    const d = (await owner.get(`/api/orgs/${orgId}/dashboard`)).body;
    expect(d.tasks).toEqual({ open: 1, overdue: 1, done: 1 });
    expect(d.projectsByStatus).toEqual([{ status: "active", count: 1 }]);
    expect(d.myTasks.map((t: { title: string }) => t.title)).toEqual(["Overdue"]);
    // Calendar dates round-trip exactly, regardless of the server's time zone.
    expect(d.myTasks[0].due_date).toBe("2020-01-01");

    const auditRows = (await owner.get(`/api/orgs/${orgId}/audit`)).body;
    expect(auditRows.map((a: { action: string }) => a.action)).toEqual(["task.create", "task.create", "project.create", "org.create"]);
  });
});

describe("persistence", () => {
  it("keeps data across a server restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openbuild-"));
    try {
      const first = await makeApp({ dataDir: dir });
      const { client, orgId } = await registerOwner(first.app);
      await client.post(`/api/orgs/${orgId}/projects`, { name: "Survives restart" });
      const cookie = client.cookie;
      await first.app.close();
      await first.db.close();

      const second = await makeApp({ dataDir: dir });
      const c = new Client(second.app);
      c.cookie = cookie; // session survives too
      const projects = await c.get(`/api/orgs/${orgId}/projects`);
      expect(projects.body.map((p: { name: string }) => p.name)).toEqual(["Survives restart"]);
      await second.app.close();
      await second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
