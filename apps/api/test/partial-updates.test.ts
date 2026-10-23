import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

/**
 * A PATCH that sends one field must leave every other field alone. zod's `.partial()` re-applies `.default()`
 * values, which used to reset statuses, retainage, reasons and lines on unrelated edits.
 */
let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;
let cc: string;
let memberId: string;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
  await owner.post(`${P}/cost-codes`, { code: "03-300", description: "Concrete" });
  cc = (await owner.get(`${P}/cost-codes`)).body[0].id;
  ({ userId: memberId } = await inviteAndJoin(app, owner, orgId, "m@example.com", { projectId, projectRole: "manager" }));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("partial updates keep unspecified fields", () => {
  it("tasks", async () => {
    const t = (await owner.post(`${P}/tasks`, { title: "Order rebar", status: "done" })).body;
    await owner.patch(`/api/tasks/${t.id}`, { title: "Order rebar (#4)" });
    const row = (await owner.get(`${P}/tasks`)).body.find((x: { id: string }) => x.id === t.id);
    expect(row).toMatchObject({ title: "Order rebar (#4)", status: "done" });
  });

  it("meeting action items", async () => {
    const m = (await owner.post(`${P}/meetings`, { title: "OAC", startsAt: "2026-10-05T09:00:00Z", agenda: ["Pour schedule"] })).body;
    const item = (await owner.get(`/api/meetings/${m.id}`)).body.items[0];
    await owner.patch(`/api/meetings/${m.id}/items/${item.id}`, { assigneeId: memberId });
    await owner.patch(`/api/meetings/${m.id}/items/${item.id}`, { status: "closed" });
    await owner.patch(`/api/meetings/${m.id}/items/${item.id}`, { notes: "Moved to Friday" });
    expect((await owner.get(`/api/meetings/${m.id}`)).body.items[0]).toMatchObject({ notes: "Moved to Friday", status: "closed" });
  });

  it("contracts", async () => {
    const k = (await owner.post(`${P}/contracts`, { kind: "subcontract", title: "Concrete", counterparty: "Acme", retainagePercent: "10", lines: [{ costCodeId: cc, description: "Slab", amount: "5000" }] })).body;
    expect((await owner.patch(`/api/contracts/${k.id}`, { title: "Concrete package" })).status).toBe(200);
    const d = (await owner.get(`/api/contracts/${k.id}`)).body;
    expect(d).toMatchObject({ title: "Concrete package", retainage_percent: "10.00" });
    expect(d.lines).toHaveLength(1);
  });

  it("change events and change orders", async () => {
    const ce = (await owner.post(`${P}/change-events`, { title: "Rock", reason: "unforeseen_condition", scope: "out_of_scope", lines: [{ costCodeId: cc, description: "Rock removal", estimatedCost: "900", estimatedRevenue: "1000" }] })).body;
    expect((await owner.patch(`/api/change-events/${ce.id}`, { title: "Rock at grid C" })).status).toBe(200);
    const d = (await owner.get(`/api/change-events/${ce.id}`)).body;
    expect(d).toMatchObject({ title: "Rock at grid C", reason: "unforeseen_condition", scope: "out_of_scope" });
    expect(d.lines).toHaveLength(1);

    const k = (await owner.post(`${P}/contracts`, { kind: "prime", title: "Prime", counterparty: "Owner", lines: [{ costCodeId: cc, description: "Work", amount: "100000" }] })).body;
    await owner.post(`/api/contracts/${k.id}/status`, { status: "approved" });
    const co = (await owner.post(`${P}/change-orders`, { contractId: k.id, title: "CO 1", scheduleImpactDays: 5, lines: [{ costCodeId: cc, description: "Rock", amount: "1000" }] })).body;
    expect((await owner.patch(`/api/change-orders/${co.id}`, { title: "CO 1 — rock" })).status).toBe(200);
    expect((await owner.get(`/api/change-orders/${co.id}`)).body).toMatchObject({ title: "CO 1 — rock", schedule_impact_days: 5 });
  });

  it("submittals", async () => {
    const s = (await owner.post(`${P}/submittals`, { title: "Rebar shop drawings", type: "sample", reviewerIds: [memberId] })).body;
    expect((await owner.patch(`/api/submittals/${s.id}`, { title: "Rebar samples" })).status).toBe(200);
    const d = (await owner.get(`/api/submittals/${s.id}`)).body;
    expect(d).toMatchObject({ title: "Rebar samples", type: "sample" });
    expect(d.reviewer_ids ?? d.reviewers?.map((r: { id: string }) => r.id)).toContain(memberId);
  });

  it("schedule activities", async () => {
    const a = (await owner.post(`${P}/schedule`, { name: "Pour L2", startDate: "2026-10-05", endDate: "2026-10-09", percentComplete: 60 })).body;
    await owner.patch(`/api/schedule/${a.id}`, { name: "Pour level 2" });
    const row = (await owner.get(`${P}/schedule`)).body.find((x: { id: string }) => x.id === a.id);
    expect(row).toMatchObject({ name: "Pour level 2", percent_complete: 60, is_milestone: false });
  });
});
