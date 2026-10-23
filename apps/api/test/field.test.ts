import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let ownerId: string;
let projectId: string;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId, userId: ownerId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("daily logs", () => {
  it("records weather and manpower with decimal-safe hours, one log per day, locks on sign", async () => {
    const log = await owner.post(`/api/projects/${projectId}/daily-logs`, {
      logDate: "2026-10-20", weather: "Rain", tempLow: 41, tempHigh: 55.5, workPerformed: "Formed L2 deck",
      manpower: [{ company: "Acme Concrete", trade: "Concrete", workers: 8, hours: "63.75" }, { company: "Spark Electric", workers: 3, hours: 24.1 }],
    });
    expect(log.status).toBe(201);
    expect((await owner.post(`/api/projects/${projectId}/daily-logs`, { logDate: "2026-10-20" })).status).toBe(409);
    expect((await owner.post(`/api/projects/${projectId}/daily-logs`, { logDate: "2026-10-21", manpower: [{ company: "x", workers: 1, hours: "1.234" }] })).status).toBe(400);

    const list = (await owner.get(`/api/projects/${projectId}/daily-logs`)).body;
    expect(list[0]).toMatchObject({ workers: 11, hours: "87.85" });

    const detail = (await owner.get(`/api/daily-logs/${log.body.id}`)).body;
    expect(detail.manpower.map((m: { hours: string }) => m.hours).sort()).toEqual(["24.10", "63.75"]);

    expect((await owner.patch(`/api/daily-logs/${log.body.id}`, { notes: "Pump truck late", manpower: [{ company: "Acme Concrete", workers: 9, hours: "72" }] })).status).toBe(200);
    expect((await owner.get(`/api/daily-logs/${log.body.id}`)).body.manpower).toHaveLength(1);

    const { client: contrib } = await inviteAndJoin(app, owner, orgId, "c@example.com", { projectId, projectRole: "contributor" });
    expect((await contrib.post(`/api/daily-logs/${log.body.id}/sign`)).status).toBe(403);
    expect((await owner.post(`/api/daily-logs/${log.body.id}/sign`)).status).toBe(200);
    expect((await owner.patch(`/api/daily-logs/${log.body.id}`, { notes: "x" })).status).toBe(409);
  });

  it("is idempotent for offline replays with the same clientId", async () => {
    const clientId = randomUUID();
    const a = await owner.post(`/api/projects/${projectId}/daily-logs`, { logDate: "2026-10-22", notes: "offline", clientId });
    const b = await owner.post(`/api/projects/${projectId}/daily-logs`, { logDate: "2026-10-22", notes: "offline", clientId });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.replayed).toBe(true);
    expect((await owner.get(`/api/projects/${projectId}/daily-logs`)).body).toHaveLength(1);
  });
});

describe("inspections and punch list", () => {
  it("runs a template inspection, turns a failure into a punch item, and closes it with a photo", async () => {
    const { client: sub, userId: subId } = await inviteAndJoin(app, owner, orgId, "sub@example.com", { projectId, projectRole: "viewer" });
    const tpl = (await owner.post(`/api/orgs/${orgId}/inspection-templates`, { name: "Pre-pour", items: ["Rebar spacing per plan", "Embeds installed", "Formwork braced"] })).body;
    const ins = (await owner.post(`/api/projects/${projectId}/inspections`, { title: "L2 deck pre-pour", location: "Level 2", templateId: tpl.id, items: ["Area cleaned"] })).body;
    let detail = (await owner.get(`/api/inspections/${ins.id}`)).body;
    expect(detail.items.map((i: { text: string }) => i.text)).toEqual(["Rebar spacing per plan", "Embeds installed", "Formwork braced", "Area cleaned"]);

    const [i1, i2, i3, i4] = detail.items;
    await owner.patch(`/api/inspections/${ins.id}/items/${i1.id}`, { result: "pass" });
    expect((await owner.patch(`/api/inspections/${ins.id}/items/${i3.id}`, { result: "pass", createPunch: {} })).status).toBe(400);
    const fail = await owner.patch(`/api/inspections/${ins.id}/items/${i2.id}`, { result: "fail", note: "Missing 4 plates at grid C", createPunch: { assigneeId: subId, dueDate: "2026-10-30" } });
    expect(fail.body.punchItemId).toBeTruthy();
    expect((await owner.patch(`/api/inspections/${ins.id}/items/${i2.id}`, { createPunch: {} })).status).toBe(409);
    expect((await owner.post(`/api/inspections/${ins.id}/complete`)).status).toBe(400); // 2 unanswered
    await owner.patch(`/api/inspections/${ins.id}/items/${i3.id}`, { result: "pass" });
    await owner.patch(`/api/inspections/${ins.id}/items/${i4.id}`, { result: "na" });
    expect((await owner.post(`/api/inspections/${ins.id}/complete`)).status).toBe(200);
    expect((await owner.patch(`/api/inspections/${ins.id}/items/${i4.id}`, { result: "pass" })).status).toBe(409);
    expect((await owner.get(`/api/projects/${projectId}/inspections`)).body[0]).toMatchObject({ status: "completed", failed: 1, unanswered: 0, total: 4 });

    // Punch workflow
    const punchId = fail.body.punchItemId;
    const punch = (await owner.get(`/api/punch-items/${punchId}`)).body;
    expect(punch).toMatchObject({ number: 1, title: "Embeds installed", location: "Level 2", assignee_name: "sub" });
    expect(punch.inspection.title).toBe("L2 deck pre-pour");
    expect((await sub.get("/api/me/notifications")).body.items[0].title).toMatch(/Punch item #1/);

    expect((await sub.post(`/api/punch-items/${punchId}/status`, { status: "closed" })).status).toBe(403);
    expect((await sub.post(`/api/punch-items/${punchId}/status`, { status: "ready_for_review" })).status).toBe(200);
    expect((await owner.post(`/api/punch-items/${punchId}/status`, { status: "closed", requirePhoto: true })).status).toBe(400);
    const photo = (await owner.upload(`/api/projects/${projectId}/files`, {}, { name: "embeds.jpg", type: "image/jpeg", data: JPEG })).body;
    await owner.post("/api/attachments", { entityType: "punch_item", entityId: punchId, fileId: photo.id });
    expect((await owner.post(`/api/punch-items/${punchId}/status`, { status: "closed", requirePhoto: true })).body.status).toBe("closed");
    expect((await owner.get(`/api/inspections/${ins.id}`)).body.items[1].punch_status).toBe("closed");
    expect((await owner.patch(`/api/punch-items/${punchId}`, { title: "x" })).status).toBe(409);
    expect((await owner.get(`/api/projects/${projectId}/punch-items`)).body[0].photo_count).toBe(1);
  });

  it("filters my punch items and numbers sequentially", async () => {
    await owner.post(`/api/projects/${projectId}/punch-items`, { title: "Touch up paint", assigneeId: ownerId });
    await owner.post(`/api/projects/${projectId}/punch-items`, { title: "Missing cover plate" });
    const mine = (await owner.get(`/api/projects/${projectId}/punch-items?mine=1`)).body;
    expect(mine.map((p: { number: number }) => p.number)).toEqual([1]);
    expect((await owner.get(`/api/projects/${projectId}/punch-items`)).body.map((p: { number: number }) => p.number)).toEqual([1, 2]);
  });
});

describe("safety", () => {
  it("records observations and closes them with a resolution", async () => {
    const o = (await owner.post(`/api/projects/${projectId}/observations`, { type: "safety", severity: "high", title: "Unguarded floor opening", location: "L3 east" })).body;
    expect((await owner.post(`/api/observations/${o.id}/close`, {})).status).toBe(400);
    expect((await owner.post(`/api/observations/${o.id}/close`, { resolution: "Covered and labeled" })).status).toBe(200);
    expect((await owner.get(`/api/observations/${o.id}`)).body).toMatchObject({ status: "closed", resolution: "Covered and labeled" });
  });

  it("reports incidents, notifies managers, requires corrective action to close", async () => {
    const { client: pm } = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
    const { client: contrib } = await inviteAndJoin(app, owner, orgId, "c@example.com", { projectId, projectRole: "contributor" });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await contrib.post(`/api/projects/${projectId}/incidents`, { occurredAt: future, type: "near_miss", title: "x", description: "y" })).status).toBe(400);
    const inc = await contrib.post(`/api/projects/${projectId}/incidents`, {
      occurredAt: "2026-10-21T14:30:00-04:00", type: "injury", title: "Laceration to hand", description: "Cut while handling sheet metal", injuredParty: "J. Doe", oshaRecordable: true,
    });
    expect(inc.status).toBe(201);
    expect((await pm.get("/api/me/notifications")).body.items[0].title).toMatch(/Incident reported/);
    expect((await owner.get("/api/me/notifications")).body.items[0].title).toMatch(/Incident reported/);
    expect((await contrib.patch(`/api/incidents/${inc.body.id}`, { status: "closed" })).status).toBe(403);
    expect((await pm.patch(`/api/incidents/${inc.body.id}`, { status: "closed" })).status).toBe(400);
    expect((await pm.patch(`/api/incidents/${inc.body.id}`, { status: "closed", rootCause: "No cut gloves", correctiveAction: "Cut-resistant gloves required" })).body.status).toBe("closed");
  });
});
