import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base32Encode, totp, verifyTotp } from "../src/lib/totp.js";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;

let projectId: string;

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("meetings", () => {
  it("records agenda, action items and publishes minutes to attendees", async () => {
    const { client: pm, userId: pmId } = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
    const m = (await owner.post(`/api/projects/${projectId}/meetings`, { title: "OAC meeting #12", startsAt: "2026-10-23T14:00:00Z", location: "Trailer", attendeeIds: [pmId], agenda: ["Safety", "Schedule"] })).body;
    expect((await pm.get("/api/me/notifications")).body.items[0].title).toMatch(/OAC meeting #12/);
    const action = (await owner.post(`/api/meetings/${m.id}/items`, { topic: "Confirm crane date", assigneeId: pmId, dueDate: "2026-10-30" })).body;
    const detail = (await owner.get(`/api/meetings/${m.id}`)).body;
    expect(detail.items.map((i: { topic: string }) => i.topic)).toEqual(["Safety", "Schedule", "Confirm crane date"]);
    expect(detail.attendees[0].name).toBe("pm");
    await owner.patch(`/api/meetings/${m.id}/items/${detail.items[0].id}`, { notes: "No incidents this week" });
    expect((await owner.get(`/api/projects/${projectId}/meetings`)).body[0].open_actions).toBe(1);
    expect((await owner.post(`/api/meetings/${m.id}/publish`)).status).toBe(200);
    expect((await owner.post(`/api/meetings/${m.id}/items`, { topic: "late" })).status).toBe(409);
    expect((await pm.get("/api/me/notifications")).body.items[0].title).toMatch(/Minutes published/);
    expect((await owner.patch(`/api/meetings/${m.id}/items/${action.id}`, { status: "closed" })).body.status).toBe("closed");
  });
});

describe("timesheets", () => {
  it("workers log their own time; managers approve others' time with decimal-safe totals", async () => {
    const { client: worker } = await inviteAndJoin(app, owner, orgId, "w@example.com", { projectId, projectRole: "subcontractor" });
    const T = `/api/projects/${projectId}/timesheets`;
    const e1 = (await worker.post(T, { workDate: "2026-10-20", hours: "7.75", description: "Rough-in" })).body;
    await worker.post(T, { workDate: "2026-10-21", hours: 8.1 });
    expect((await worker.post(T, { workDate: "2026-10-21", hours: 16 })).status).toBe(400); // >24 h/day
    expect((await worker.post(T, { workDate: "2026-10-22", hours: "1.234" })).status).toBe(400);
    expect((await worker.post(T, { workDate: "2099-01-01", hours: 1 })).status).toBe(400);
    const mine = (await worker.get(T)).body;
    expect(mine.canApprove).toBe(false);
    expect(mine.totals.allHours).toBe("15.85");
    expect((await worker.post(`/api/timesheets/${e1.id}/decide`, { decision: "approved" })).status).toBe(403); // only managers approve
    const own = (await owner.post(T, { workDate: "2026-10-20", hours: 2 })).body;
    expect((await owner.post(`/api/timesheets/${own.id}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await owner.post(`/api/timesheets/${e1.id}/decide`, { decision: "approved" })).status).toBe(200);
    expect((await owner.post(`/api/timesheets/${e1.id}/decide`, { decision: "rejected" })).status).toBe(409);
    const all = (await owner.get(T)).body;
    expect(all.entries).toHaveLength(3);
    expect(all.totals).toEqual({ approvedHours: "7.75", allHours: "17.85" });
    expect((await worker.get("/api/me/notifications")).body.items[0].title).toMatch(/approved/);
  });
});

describe("two-factor login", () => {
  it("matches the RFC 6238 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    // RFC 6238 Appendix B, SHA-1, T=59 → 94287082 (8 digits); the 6-digit code is its last 6 digits.
    expect(totp(secret, 59_000, 8)).toBe("94287082");
    expect(totp(secret, 1_111_111_109_000, 8)).toBe("07081804");
    expect(verifyTotp(secret, totp(secret, 1_000_000 + 30_000), 1_000_000)).toBe(true);
    expect(verifyTotp(secret, "12345x")).toBe(false);
  });

  it("enrols, requires the code at login, and can be turned off", async () => {
    const setup = (await owner.post("/api/me/mfa/setup")).body;
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/OpenBuild/);
    expect((await owner.post("/api/me/mfa/enable", { code: "000000" })).status).toBe(400);
    const enabled = (await owner.post("/api/me/mfa/enable", { code: totp(setup.secret) })).body;
    expect(enabled.recoveryCodes).toHaveLength(10);
    expect((await owner.get("/api/me")).body.user.mfaEnabled).toBe(true);

    const c = new Client(app);
    const noCode = await c.post("/api/auth/login", { email: "owner@example.com", password: "correct horse battery" });
    expect(noCode.status).toBe(401);
    expect(noCode.body.mfaRequired).toBe(true);
    expect((await c.post("/api/auth/login", { email: "owner@example.com", password: "correct horse battery", code: "123456" })).status).toBe(401);
    expect((await c.post("/api/auth/login", { email: "owner@example.com", password: "wrong password!", code: totp(setup.secret) })).status).toBe(401);
    expect((await c.post("/api/auth/login", { email: "owner@example.com", password: "correct horse battery", code: totp(setup.secret) })).status).toBe(200);

    // A recovery code signs in exactly once
    const rc = enabled.recoveryCodes[0];
    expect((await new Client(app).post("/api/auth/login", { email: "owner@example.com", password: "correct horse battery", code: rc })).status).toBe(200);
    expect((await new Client(app).post("/api/auth/login", { email: "owner@example.com", password: "correct horse battery", code: rc })).status).toBe(401);
    expect((await owner.post("/api/me/mfa/disable", { password: "nope", code: totp(setup.secret) })).status).toBe(400);
    expect((await owner.post("/api/me/mfa/disable", { password: "correct horse battery", code: totp(setup.secret) })).status).toBe(200);
    expect((await new Client(app).post("/api/auth/login", { email: "owner@example.com", password: "correct horse battery" })).status).toBe(200);

  });
});

describe("two-factor reset by an administrator", () => {
  it("lets the owner reset a member's lost second factor, but not across organizations", async () => {
    const { client: m, userId } = await inviteAndJoin(app, owner, orgId, "m@example.com");
    const setup = (await m.post("/api/me/mfa/setup")).body;
    await m.post("/api/me/mfa/enable", { code: totp(setup.secret) });
    expect((await new Client(app).post("/api/auth/login", { email: "m@example.com", password: "another long password" })).body.mfaRequired).toBe(true);
    const { client: admin } = await inviteAndJoin(app, owner, orgId, "a@example.com", { orgRole: "admin" });
    expect((await admin.post(`/api/orgs/${orgId}/members/${userId}/reset-mfa`)).status).toBe(200);
    expect((await m.get("/api/me")).status).toBe(401); // sessions revoked
    expect((await new Client(app).post("/api/auth/login", { email: "m@example.com", password: "another long password" })).status).toBe(200);
    const ownerId = (await owner.get("/api/me")).body.user.id;
    expect((await admin.post(`/api/orgs/${orgId}/members/${ownerId}/reset-mfa`)).status).toBe(403);
    const other = await registerOwner(app, "o2@example.com");
    expect((await other.client.post(`/api/orgs/${orgId}/members/${userId}/reset-mfa`)).status).toBe(404);
  });
});
