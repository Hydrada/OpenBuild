import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportAll, importAll } from "../src/db/backup.js";
import { parseCsv } from "../src/routes/collab.js";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;

let projectId: string;
let sent: { to: string; subject: string; text: string }[];

beforeEach(async () => {
  sent = [];
  ({ app, db } = await makeApp({
    mailer: async (to, subject, text) => void sent.push({ to, subject, text }),
    documentTools: [{ id: "opendraft", name: "OpenDraft" }, { id: "acrobat-alt", name: "Acrobat alternative", urlTemplate: "http://tool.test/open?src={downloadUrl}&save={uploadUrl}&n={name}" }],
  }));
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("subcontractor portal", () => {
  it("sees drawings and only the records assigned to them", async () => {
    const { client: sub, userId: subId } = await inviteAndJoin(app, owner, orgId, "sub@acme-electric.test", { projectId, projectRole: "subcontractor", company: "Acme Electric" });
    const sheet = await owner.upload(`/api/projects/${projectId}/drawings`, { number: "E-101", title: "Power plan", revision: "0" }, { name: "e.pdf", type: "application/pdf", data: PDF() });
    const mine = (await owner.post(`/api/projects/${projectId}/rfis`, { subject: "Panel location", question: "Where?", assigneeId: subId })).body;
    const other = (await owner.post(`/api/projects/${projectId}/rfis`, { subject: "Owner budget question", question: "Internal" })).body;
    const myPunch = (await owner.post(`/api/projects/${projectId}/punch-items`, { title: "Missing cover plate", assigneeId: subId })).body;
    await owner.post(`/api/projects/${projectId}/punch-items`, { title: "Paint touch-up" });
    await owner.post(`/api/projects/${projectId}/daily-logs`, { logDate: "2026-10-20", notes: "internal" });

    // Visible
    expect((await sub.get(`/api/projects/${projectId}/drawings`)).body).toHaveLength(1);
    const fileId = (await sub.get(`/api/drawings/${sheet.body.drawingId}`)).body.revisions[0].file_id;
    expect((await sub.raw(`/api/files/${fileId}/download`)).statusCode).toBe(200);
    expect((await sub.get(`/api/projects/${projectId}/rfis`)).body.map((r: { subject: string }) => r.subject)).toEqual(["Panel location"]);
    expect((await sub.get(`/api/rfis/${mine.id}`)).status).toBe(200);
    expect((await sub.get(`/api/projects/${projectId}/punch-items`)).body).toHaveLength(1);

    // Hidden
    expect((await sub.get(`/api/rfis/${other.id}`)).status).toBe(404);
    for (const path of ["daily-logs", "budget", "contracts", "members", "tasks", "activity", "files", "inspections", "incidents", "change-orders", "invoices", "export/rfis.csv"]) {
      expect((await sub.get(`/api/projects/${projectId}/${path}`)).status, path).toBe(403);
    }
    expect((await sub.post(`/api/projects/${projectId}/rfis`, { subject: "x", question: "y" })).status).toBe(403);
    expect((await sub.get(`/api/orgs/${orgId}/dashboard`)).body.activity).toHaveLength(0);

    // Can answer their RFI and complete their punch item with a photo
    expect((await sub.post(`/api/rfis/${mine.id}/responses`, { body: "North wall of room 104", official: true })).status).toBe(201);
    const photo = (await sub.upload(`/api/projects/${projectId}/files`, {}, { name: "plate.jpg", type: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]) })).body;
    expect((await sub.post("/api/attachments", { entityType: "punch_item", entityId: myPunch.id, fileId: photo.id })).status).toBe(201);
    expect((await sub.post(`/api/punch-items/${myPunch.id}/status`, { status: "ready_for_review" })).status).toBe(200);
    expect((await sub.post(`/api/punch-items/${myPunch.id}/status`, { status: "closed" })).status).toBe(403);

    const work = (await sub.get("/api/me/work")).body;
    expect(work.punch).toHaveLength(0); // ready for review is no longer open
    expect((await owner.get(`/api/orgs/${orgId}/members`)).body.members.find((m: { email: string }) => m.email === "sub@acme-electric.test").company).toBe("Acme Electric");
  });
});

describe("comments and mentions", () => {
  it("notifies mentioned people and the record owner", async () => {
    const { client: pm, userId: pmId } = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
    const rfi = (await pm.post(`/api/projects/${projectId}/rfis`, { subject: "Slab edge", question: "?" })).body;
    const outsider = await registerOwner(app, "out@example.com");
    expect((await owner.post("/api/comments", { entityType: "rfi", entityId: rfi.id, body: "x", mentionIds: [outsider.userId] })).status).toBe(400);
    expect((await owner.post("/api/comments", { entityType: "rfi", entityId: rfi.id, body: "Looping in @pm", mentionIds: [pmId] })).status).toBe(201);
    const list = (await pm.get(`/api/comments?entityType=rfi&entityId=${rfi.id}`)).body;
    expect(list[0]).toMatchObject({ body: "Looping in @pm", author_name: "Olive Owner" });
    const notes = (await pm.get("/api/me/notifications")).body;
    expect(notes.items.filter((n: { kind: string }) => n.kind === "mention")).toHaveLength(1);
    expect(notes.unread).toBeGreaterThan(0);
    await pm.post("/api/me/notifications/read", {});
    expect((await pm.get("/api/me/notifications")).body.unread).toBe(0);
    expect((await outsider.client.get(`/api/comments?entityType=rfi&entityId=${rfi.id}`)).status).toBe(404);
    expect(sent.some((m) => m.to === "pm@example.com" && /mentioned you/.test(m.subject))).toBe(true);
  });
});

describe("email", () => {
  it("emails invitations and reset links when a mailer is configured", async () => {
    const inv = await owner.post(`/api/orgs/${orgId}/invitations`, { email: "new@example.com" });
    expect(inv.body.emailSent).toBe(true);
    expect(sent[0]).toMatchObject({ to: "new@example.com" });
    expect(sent[0]!.text).toContain(`http://openbuild.test${inv.body.acceptPath}`);
  });
});

describe("API keys", () => {
  it("authenticates without cookies or CSRF, is bound to one org, and can be revoked", async () => {
    const other = await registerOwner(app, "other@example.com");
    // Owner also belongs to a second org — the key must not reach it.
    const inv = await other.client.post(`/api/orgs/${other.orgId}/invitations`, { email: "owner@example.com", orgRole: "admin" });
    await owner.post(`/api/invitations/${inv.body.acceptPath.split("/").pop()}/accept`);
    const otherProject = (await other.client.post(`/api/orgs/${other.orgId}/projects`, { name: "Other org project" })).body.id;

    const key = (await owner.post(`/api/orgs/${orgId}/api-keys`, { name: "Reporting" })).body;
    expect(key.secret).toMatch(/^ob_/);
    const api = new Client(app);
    const call = (method: string, url: string, body?: unknown) =>
      app.inject({ method: method as "GET", url, payload: body as object, headers: { authorization: `Bearer ${key.secret}` } });

    expect((await call("GET", `/api/orgs/${orgId}/projects`)).statusCode).toBe(200);
    const created = await call("POST", `/api/projects/${projectId}/rfis`, { subject: "Via API", question: "Hello" });
    expect(created.statusCode).toBe(201);
    expect((await call("GET", `/api/orgs/${other.orgId}/projects`)).statusCode).toBe(404);
    expect((await call("GET", `/api/projects/${otherProject}`)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/orgs/${orgId}/projects`, headers: { authorization: "Bearer ob_wrong" } })).statusCode).toBe(401);

    const keys = (await owner.get(`/api/orgs/${orgId}/api-keys`)).body;
    expect(keys[0].last_used_at).toBeTruthy();
    expect(JSON.stringify(keys)).not.toContain(key.secret);
    await owner.del(`/api/orgs/${orgId}/api-keys/${key.id}`);
    expect((await call("GET", `/api/orgs/${orgId}/projects`)).statusCode).toBe(401);
    expect(api.cookie).toBe("");
  });
});

describe("document tool integration", () => {
  it("round-trips a revision through a scoped tool link", async () => {
    const sheet = await owner.upload(`/api/projects/${projectId}/drawings`, { number: "A-101", title: "Plan", revision: "2" }, { name: "A-101.pdf", type: "application/pdf", data: PDF("original") });
    const revId = (await owner.get(`/api/drawings/${sheet.body.drawingId}`)).body.revisions[0].id;
    expect((await owner.post(`/api/drawing-revisions/${revId}/tool-session`, { tool: "nope" })).status).toBe(400);
    const s = (await owner.post(`/api/drawing-revisions/${revId}/tool-session`, { tool: "acrobat-alt" })).body;
    expect(s.launchUrl).toContain("http://tool.test/open?src=");
    expect(decodeURIComponent(s.launchUrl)).toContain("/api/tool/");

    const anon = new Client(app);
    const path = (u: string) => new URL(u).pathname;
    const dl = await anon.raw(path(s.downloadUrl));
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain("original");
    const up = await anon.upload(path(s.uploadUrl), { note: "Clouded revisions" }, { name: "marked.pdf", type: "application/pdf", data: PDF("marked") });
    expect(up.status).toBe(201);
    expect((await anon.upload(path(s.uploadUrl), {}, { name: "again.pdf", type: "application/pdf", data: PDF() })).status).toBe(410);
    const markups = (await owner.get(`/api/drawings/${sheet.body.drawingId}`)).body.revisions[0].markups;
    expect(markups[0]).toMatchObject({ tool: "acrobat-alt", note: "Clouded revisions" });
    expect((await anon.raw("/api/tool/not-a-token/file")).statusCode).toBe(404);
  });
});

describe("custom fields", () => {
  it("defines typed fields and validates values", async () => {
    const f1 = await owner.post(`/api/orgs/${orgId}/custom-fields`, { entityType: "rfi", key: "discipline", label: "Discipline", type: "select", options: ["Arch", "Struct", "MEP"], required: true });
    expect(f1.status).toBe(201);
    await owner.post(`/api/orgs/${orgId}/custom-fields`, { entityType: "rfi", key: "cost_estimate", label: "Cost estimate", type: "number" });
    expect((await owner.post(`/api/orgs/${orgId}/custom-fields`, { entityType: "rfi", key: "discipline", label: "dup", type: "text" })).status).toBe(409);
    expect((await owner.post(`/api/orgs/${orgId}/custom-fields`, { entityType: "rfi", key: "Bad Key", label: "x", type: "text" })).status).toBe(400);

    const rfi = (await owner.post(`/api/projects/${projectId}/rfis`, { subject: "s", question: "q" })).body;
    expect((await owner.put(`/api/custom-values/rfi/${rfi.id}`, { values: { discipline: "Plumbing" } })).status).toBe(400);
    expect((await owner.put(`/api/custom-values/rfi/${rfi.id}`, { values: { cost_estimate: "abc" } })).status).toBe(400);
    expect((await owner.put(`/api/custom-values/rfi/${rfi.id}`, { values: { discipline: null } })).status).toBe(400);
    expect((await owner.put(`/api/custom-values/rfi/${rfi.id}`, { values: { nope: "x" } })).status).toBe(400);
    expect((await owner.put(`/api/custom-values/rfi/${rfi.id}`, { values: { discipline: "MEP", cost_estimate: 1250.5 } })).status).toBe(200);
    const vals = (await owner.get(`/api/custom-values/rfi/${rfi.id}`)).body;
    expect(vals.map((v: { key: string; value: string }) => [v.key, v.value])).toEqual([["discipline", "MEP"], ["cost_estimate", "1250.5"]]);
    expect((await owner.put(`/api/custom-values/project/${projectId}`, { values: {} })).status).toBe(200);
  });
});

describe("import and export", () => {
  it("imports punch items from CSV and exports lists", async () => {
    expect(parseCsv('a,"b ""q"", c"\r\n1,2\n')).toEqual([["a", 'b "q", c'], ["1", "2"]]);
    const r = await owner.post(`/api/projects/${projectId}/import/punch-items`, { csv: 'Title,Location,Trade,Due\nPatch drywall,"Room 101, east wall",Drywall,2026-11-01\nReplace ceiling tile,Corridor,,\n' });
    expect(r.body.created).toBe(2);
    expect((await owner.post(`/api/projects/${projectId}/import/punch-items`, { csv: "Title,Due\nX,11/01/2026\n" })).status).toBe(400);
    expect((await owner.post(`/api/projects/${projectId}/import/punch-items`, { csv: "Name\nX\n" })).status).toBe(400);
    const csv = await owner.raw(`/api/projects/${projectId}/export/punch-items.csv`);
    const rows = parseCsv(csv.body);
    expect(rows[0]).toEqual(["Number", "Title", "Location", "Trade", "Status", "Assignee", "Due", "Closed"]);
    expect(rows[1]!.slice(0, 4)).toEqual(["1", "Patch drywall", "Room 101, east wall", "Drywall"]);
    // Spreadsheet formula injection is neutralised
    await owner.post(`/api/projects/${projectId}/tasks`, { title: "=HYPERLINK(\"http://evil\")" });
    expect((await owner.raw(`/api/projects/${projectId}/export/tasks.csv`)).body).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe("backup and restore", () => {
  it("restores a complete copy into an empty database", async () => {
    const { userId: pmId } = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
    await owner.post(`/api/projects/${projectId}/cost-codes`, { code: "03-300", description: "Concrete" });
    await owner.post(`/api/orgs/${orgId}/inspection-templates`, { name: "T", items: ["a", "b"] });
    await owner.post(`/api/orgs/${orgId}/custom-fields`, { entityType: "rfi", key: "zone", label: "Zone", type: "select", options: ["A", "B"] });
    await owner.post(`/api/projects/${projectId}/rfis`, { subject: "s", question: "q", assigneeId: pmId });
    const backup = JSON.parse(JSON.stringify(await exportAll(db)));

    const target = await makeApp({ storageDir: mkdtempSync(join(tmpdir(), "ob-restore-")) });
    try {
      const counts = await importAll(target.db, backup);
      expect(counts.rfis).toBe(1);
      expect(counts.audit_log).toBe(backup.tables.audit_log.length);
      await expect(importAll(target.db, backup)).rejects.toThrow(/not empty/);
      const c = new Client(target.app);
      expect((await c.post("/api/auth/login", { email: "owner@example.com", password: "correct horse battery" })).status).toBe(200);
      expect((await c.get(`/api/projects/${projectId}/rfis`)).body[0]).toMatchObject({ number: 1, assignee_name: "pm" });
      const tpl = (await c.get(`/api/orgs/${orgId}/inspection-templates`)).body[0];
      expect(tpl.items).toEqual(["a", "b"]);
      // New audit rows continue after the restored ones
      await c.post(`/api/projects/${projectId}/rfis`, { subject: "after restore", question: "q" });
      expect((await c.get(`/api/projects/${projectId}/rfis`)).body[0].number).toBe(2);
    } finally {
      await target.app.close();
      await target.db.close();
    }
  });
});
