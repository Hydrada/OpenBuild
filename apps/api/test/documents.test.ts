import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let ownerId: string;
let projectId: string;

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId, userId: ownerId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("accounts", () => {
  it("admin-issued reset link sets a new password once and signs out old sessions", async () => {
    const { client: m, userId } = await inviteAndJoin(app, owner, orgId, "m@example.com");
    const link = await owner.post(`/api/orgs/${orgId}/members/${userId}/reset-link`);
    expect(link.status).toBe(201);
    const token = link.body.resetPath.split("/").pop();
    const anon = new Client(app);
    expect((await anon.get(`/api/password-resets/${token}`)).body.email).toBe("m@example.com");
    expect((await anon.post(`/api/password-resets/${token}`, { password: "brand new password" })).status).toBe(200);
    expect((await anon.post(`/api/password-resets/${token}`, { password: "brand new password" })).status).toBe(410);
    expect((await m.get("/api/me")).status).toBe(401); // old session revoked
    expect((await anon.post("/api/auth/login", { email: "m@example.com", password: "brand new password" })).status).toBe(200);
  });

  it("admins cannot reset admins; members cannot issue resets", async () => {
    const { client: admin } = await inviteAndJoin(app, owner, orgId, "a@example.com", { orgRole: "admin" });
    const { client: m, userId: mId } = await inviteAndJoin(app, owner, orgId, "m@example.com");
    expect((await admin.post(`/api/orgs/${orgId}/members/${ownerId}/reset-link`)).status).toBe(403);
    expect((await m.post(`/api/orgs/${orgId}/members/${mId}/reset-link`)).status).toBe(403);
    expect((await admin.post(`/api/orgs/${orgId}/members/${mId}/reset-link`)).status).toBe(201);
  });

  it("refuses reset links for people who also belong to another org", async () => {
    const other = await registerOwner(app, "other@example.com");
    const inv = await owner.post(`/api/orgs/${orgId}/invitations`, { email: "other@example.com" });
    await other.client.post(`/api/invitations/${inv.body.acceptPath.split("/").pop()}/accept`);
    expect((await owner.post(`/api/orgs/${orgId}/members/${other.userId}/reset-link`)).status).toBe(403);
  });

  it("changes password, lists and revokes sessions", async () => {
    const second = new Client(app);
    await second.post("/api/auth/login", { email: "owner@example.com", password: "correct horse battery" });
    const sessions = (await owner.get("/api/me/sessions")).body;
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s: { current: boolean }) => !s.current);
    expect((await owner.del(`/api/me/sessions/${other.id}`)).status).toBe(200);
    expect((await second.get("/api/me")).status).toBe(401);

    expect((await owner.post("/api/me/password", { currentPassword: "wrong", newPassword: "another long password" })).status).toBe(400);
    expect((await owner.post("/api/me/password", { currentPassword: "correct horse battery", newPassword: "another long password" })).status).toBe(200);
    expect((await owner.get("/api/me")).status).toBe(200); // current session kept
  });

  it("removing a member revokes project access", async () => {
    const { client: m, userId } = await inviteAndJoin(app, owner, orgId, "m@example.com", { projectId, projectRole: "contributor" });
    expect((await m.get(`/api/projects/${projectId}`)).status).toBe(200);
    expect((await owner.del(`/api/orgs/${orgId}/members/${ownerId}`)).status).toBe(400);
    expect((await owner.del(`/api/orgs/${orgId}/members/${userId}`)).status).toBe(200);
    expect((await m.get(`/api/projects/${projectId}`)).status).toBe(404);
  });
});

describe("drawings", () => {
  it("uploads sheets, supersedes with revisions, keeps history, rejects non-PDF and duplicates", async () => {
    const r0 = await owner.upload(`/api/projects/${projectId}/drawings`, { number: "A-101", title: "Ground floor plan", discipline: "Architectural", revision: "0", setName: "IFC", issuedDate: "2026-09-01" }, { name: "A-101.pdf", type: "application/pdf", data: PDF("r0") });
    expect(r0.status).toBe(201);
    const r1 = await owner.upload(`/api/projects/${projectId}/drawings`, { number: "A-101", revision: "1" }, { name: "A-101 r1.pdf", type: "application/pdf", data: PDF("r1") });
    expect(r1.status).toBe(201);
    expect(r1.body.drawingId).toBe(r0.body.drawingId);
    expect((await owner.upload(`/api/projects/${projectId}/drawings`, { number: "A-101", revision: "1" }, { name: "x.pdf", type: "application/pdf", data: PDF() })).status).toBe(409);
    expect((await owner.upload(`/api/projects/${projectId}/drawings`, { number: "A-102", title: "x", revision: "0" }, { name: "x.png", type: "image/png", data: "not a pdf" })).status).toBe(400);
    expect((await owner.upload(`/api/projects/${projectId}/drawings`, { number: "A-103", revision: "0" }, { name: "x.pdf", type: "application/pdf", data: PDF() })).status).toBe(400); // new sheet needs title

    const list = (await owner.get(`/api/projects/${projectId}/drawings`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: "A-101", current_revision: "1", revision_count: 2 });

    const detail = (await owner.get(`/api/drawings/${r0.body.drawingId}`)).body;
    expect(detail.revisions.map((r: { revision: string }) => r.revision)).toEqual(["1", "0"]);

    // Download returns the exact bytes of the old revision
    const old = await owner.raw(`/api/files/${detail.revisions[1].file_id}/download`);
    expect(old.statusCode).toBe(200);
    expect(old.body).toContain("% r0");
    expect(old.headers["content-disposition"]).toMatch(/^attachment/);
    const inline = await owner.raw(`/api/files/${detail.revisions[1].file_id}/download?inline=1`);
    expect(inline.headers["content-type"]).toBe("application/pdf");

    // Markups attach to a revision without modifying it
    const mk = await owner.upload(`/api/drawing-revisions/${detail.revisions[0].id}/markups`, { tool: "opendraft", note: "Clouded door swing" }, { name: "markup.pdf", type: "application/pdf", data: PDF("markup") });
    expect(mk.status).toBe(201);
    const after = (await owner.get(`/api/drawings/${r0.body.drawingId}`)).body;
    expect(after.revisions[0].markups[0]).toMatchObject({ tool: "opendraft", note: "Clouded door swing" });
    expect(after.tools[0].id).toBe("opendraft");
  });

  it("viewers can download but not upload; outsiders get 404 on files", async () => {
    const up = await owner.upload(`/api/projects/${projectId}/drawings`, { number: "S-1", title: "Foundations", revision: "0" }, { name: "s.pdf", type: "application/pdf", data: PDF() });
    const fileId = (await owner.get(`/api/drawings/${up.body.drawingId}`)).body.revisions[0].file_id;
    const { client: viewer } = await inviteAndJoin(app, owner, orgId, "v@example.com", { projectId, projectRole: "viewer" });
    expect((await viewer.raw(`/api/files/${fileId}/download`)).statusCode).toBe(200);
    expect((await viewer.upload(`/api/projects/${projectId}/drawings`, { number: "S-2", title: "x", revision: "0" }, { name: "s.pdf", type: "application/pdf", data: PDF() })).status).toBe(403);
    const outsider = await registerOwner(app, "out@example.com");
    expect((await outsider.client.raw(`/api/files/${fileId}/download`)).statusCode).toBe(404);
  });
});

describe("documents and approvals", () => {
  it("versions a document and routes it through sequential approvers", async () => {
    const { client: pm, userId: pmId } = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
    const { client: arch, userId: archId } = await inviteAndJoin(app, owner, orgId, "arch@example.com", { projectId, projectRole: "viewer" });
    const folder = (await owner.post(`/api/projects/${projectId}/folders`, { name: "Contracts" })).body;
    const doc = await owner.upload(`/api/projects/${projectId}/documents`, { folderId: folder.id, name: "Site logistics plan" }, { name: "plan.pdf", type: "application/pdf", data: PDF("v1") });
    expect(doc.status).toBe(201);
    expect((await owner.get(`/api/projects/${projectId}/documents?folderId=${folder.id}`)).body[0]).toMatchObject({ name: "Site logistics plan", version: 1 });

    expect((await owner.post(`/api/documents/${doc.body.id}/submit`, { approverIds: [pmId, archId] })).status).toBe(200);
    // Second approver cannot jump the queue
    let detail = (await arch.get(`/api/documents/${doc.body.id}`)).body;
    const [s1, s2] = detail.approvals;
    expect((await arch.post(`/api/approval-steps/${s2.id}/decide`, { decision: "approved" })).status).toBe(409);
    expect((await owner.post(`/api/approval-steps/${s1.id}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await arch.get("/api/me/approvals")).body).toHaveLength(0);
    expect((await pm.get("/api/me/approvals")).body).toHaveLength(1);
    expect((await pm.post(`/api/approval-steps/${s1.id}/decide`, { decision: "approved" })).body.outcome).toBeNull();
    expect((await arch.get("/api/me/approvals")).body).toHaveLength(1);
    expect((await arch.post(`/api/approval-steps/${s2.id}/decide`, { decision: "approved", comment: "OK" })).body.outcome).toBe("approved");
    detail = (await owner.get(`/api/documents/${doc.body.id}`)).body;
    expect(detail.status).toBe("approved");

    // New version resets to draft
    const v2 = await owner.upload(`/api/documents/${doc.body.id}/versions`, { note: "Updated crane location" }, { name: "plan2.pdf", type: "application/pdf", data: PDF("v2") });
    expect(v2.body.version).toBe(2);
    detail = (await owner.get(`/api/documents/${doc.body.id}`)).body;
    expect(detail.status).toBe("draft");
    expect(detail.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    // Rejection ends the round
    await owner.post(`/api/documents/${doc.body.id}/submit`, { approverIds: [pmId, archId] });
    detail = (await owner.get(`/api/documents/${doc.body.id}`)).body;
    const round2 = detail.approvals.filter((a: { round: number }) => a.round === 2);
    await pm.post(`/api/approval-steps/${round2[0].id}/decide`, { decision: "rejected", comment: "Wrong gate" });
    detail = (await owner.get(`/api/documents/${doc.body.id}`)).body;
    expect(detail.status).toBe("rejected");
    expect(detail.approvals.find((a: { round: number; seq: number }) => a.round === 2 && a.seq === 2).status).toBe("skipped");

    // Notifications were generated for approvers and creator
    const notes = (await arch.get("/api/me/notifications")).body;
    expect(notes.items.some((n: { kind: string }) => n.kind === "approval")).toBe(true);
    const ownerNotes = (await owner.get("/api/me/notifications")).body;
    expect(ownerNotes.items.some((n: { title: string }) => /rejected/.test(n.title))).toBe(true);
  });

  it("rejects approvers outside the project", async () => {
    const outsider = await registerOwner(app, "out@example.com");
    const doc = await owner.upload(`/api/projects/${projectId}/documents`, {}, { name: "x.pdf", type: "application/pdf", data: PDF() });
    expect((await owner.post(`/api/documents/${doc.body.id}/submit`, { approverIds: [outsider.userId] })).status).toBe(400);
  });
});

describe("RFIs", () => {
  it("numbers per project, assigns ball-in-court, records official answer, closes and reopens", async () => {
    const { client: arch, userId: archId } = await inviteAndJoin(app, owner, orgId, "arch@example.com", { projectId, projectRole: "viewer" });
    const sheet = await owner.upload(`/api/projects/${projectId}/drawings`, { number: "A-201", title: "Sections", revision: "0" }, { name: "a.pdf", type: "application/pdf", data: PDF() });
    const r1 = await owner.post(`/api/projects/${projectId}/rfis`, { subject: "Beam depth at grid C", question: "Confirm W18 vs W21?", assigneeId: archId, dueDate: "2020-01-01", drawingId: sheet.body.drawingId, costImpact: "yes" });
    const r2 = await owner.post(`/api/projects/${projectId}/rfis`, { subject: "Door hardware", question: "Which set?" });
    expect([r1.body.number, r2.body.number]).toEqual([1, 2]);

    const list = (await owner.get(`/api/projects/${projectId}/rfis`)).body;
    expect(list.find((r: { number: number }) => r.number === 1)).toMatchObject({ overdue: true, drawing_number: "A-201", assignee_name: "arch" });

    // Viewer who is the assignee can answer officially; other viewers cannot respond
    const { client: v2 } = await inviteAndJoin(app, owner, orgId, "v2@example.com", { projectId, projectRole: "viewer" });
    expect((await v2.post(`/api/rfis/${r1.body.id}/responses`, { body: "hi" })).status).toBe(403);
    expect((await arch.post(`/api/rfis/${r1.body.id}/responses`, { body: "Use W21x44.", official: true })).status).toBe(201);
    let detail = (await owner.get(`/api/rfis/${r1.body.id}`)).body;
    expect(detail.status).toBe("answered");
    expect(detail.responses[0]).toMatchObject({ body: "Use W21x44.", is_official: true });

    expect((await arch.post(`/api/rfis/${r1.body.id}/status`, { status: "closed" })).status).toBe(403);
    expect((await owner.post(`/api/rfis/${r1.body.id}/status`, { status: "closed" })).body.status).toBe("closed");
    expect((await owner.patch(`/api/rfis/${r1.body.id}`, { subject: "x" })).status).toBe(409);
    expect((await owner.post(`/api/rfis/${r1.body.id}/status`, { status: "open" })).body.status).toBe("open");

    const drawing = (await owner.get(`/api/drawings/${sheet.body.drawingId}`)).body;
    expect(drawing.rfis.map((r: { number: number }) => r.number)).toEqual([1]);
    expect((await arch.get("/api/me/notifications")).body.items[0].title).toMatch(/RFI #1/);
  });

  it("attaches files to an RFI", async () => {
    const r = (await owner.post(`/api/projects/${projectId}/rfis`, { subject: "s", question: "q" })).body;
    const f = (await owner.upload(`/api/projects/${projectId}/files`, {}, { name: "photo.jpg", type: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) })).body;
    expect((await owner.post("/api/attachments", { entityType: "rfi", entityId: r.id, fileId: f.id })).status).toBe(201);
    expect((await owner.get(`/api/rfis/${r.id}`)).body.attachments[0].name).toBe("photo.jpg");
    expect((await owner.get(`/api/projects/${projectId}/files?kind=image`)).body).toHaveLength(1);
  });

  it("rejects cross-project references", async () => {
    const other = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Other" })).body;
    const sheet = await owner.upload(`/api/projects/${other.id}/drawings`, { number: "X-1", title: "x", revision: "0" }, { name: "a.pdf", type: "application/pdf", data: PDF() });
    expect((await owner.post(`/api/projects/${projectId}/rfis`, { subject: "s", question: "q", drawingId: sheet.body.drawingId })).status).toBe(400);
  });
});

describe("specifications and submittals", () => {
  it("routes a submittal, handles revise-and-resubmit, and approves the next revision as noted", async () => {
    const { client: arch, userId: archId } = await inviteAndJoin(app, owner, orgId, "arch@example.com", { projectId, projectRole: "viewer" });
    const { client: eng, userId: engId } = await inviteAndJoin(app, owner, orgId, "eng@example.com", { projectId, projectRole: "viewer" });
    expect((await owner.post(`/api/projects/${projectId}/specs`, { number: "bogus", title: "x" })).status).toBe(400);
    const spec = (await owner.post(`/api/projects/${projectId}/specs`, { number: "05 12 00", title: "Structural steel framing" })).body;
    expect((await owner.post(`/api/projects/${projectId}/specs`, { number: "05 12 00", title: "dup" })).status).toBe(409);

    const s = (await owner.post(`/api/projects/${projectId}/submittals`, { title: "Steel shop drawings", specSectionId: spec.id, reviewerIds: [archId, engId] })).body;
    expect(s.number).toBe(1);
    expect((await owner.post(`/api/submittals/${s.id}/submit`)).status).toBe(200);
    expect((await owner.get(`/api/projects/${projectId}/submittals`)).body[0].ball_in_court).toBe("arch");

    let detail = (await owner.get(`/api/submittals/${s.id}`)).body;
    await arch.post(`/api/approval-steps/${detail.approvals[0].id}/decide`, { decision: "revise_resubmit", comment: "Add connection details" });
    detail = (await owner.get(`/api/submittals/${s.id}`)).body;
    expect(detail.status).toBe("revise_resubmit");

    const rev = await owner.post(`/api/submittals/${s.id}/revise`);
    expect(rev.status).toBe(201);
    expect((await owner.post(`/api/submittals/${s.id}/revise`)).status).toBe(409);
    await owner.post(`/api/submittals/${rev.body.id}/submit`);
    let d1 = (await owner.get(`/api/submittals/${rev.body.id}`)).body;
    expect(d1.revision).toBe(1);
    await arch.post(`/api/approval-steps/${d1.approvals[0].id}/decide`, { decision: "approved_as_noted" });
    await eng.post(`/api/approval-steps/${d1.approvals[1].id}/decide`, { decision: "approved" });
    d1 = (await owner.get(`/api/submittals/${rev.body.id}`)).body;
    expect(d1.status).toBe("approved_as_noted");
    expect(d1.revisions.map((r: { status: string }) => r.status)).toEqual(["closed", "approved_as_noted"]);
    expect((await owner.get(`/api/projects/${projectId}/specs`)).body[0].submittal_count).toBe(2);
  });

  it("cannot submit without reviewers or edit after submitting", async () => {
    const s = (await owner.post(`/api/projects/${projectId}/submittals`, { title: "Door hardware" })).body;
    expect((await owner.post(`/api/submittals/${s.id}/submit`)).status).toBe(400);
    await owner.patch(`/api/submittals/${s.id}`, { reviewerIds: [ownerId] });
    expect((await owner.post(`/api/submittals/${s.id}/submit`)).status).toBe(200);
    expect((await owner.patch(`/api/submittals/${s.id}`, { title: "x" })).status).toBe(409);
  });
});
