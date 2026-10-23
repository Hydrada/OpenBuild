import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOSEOUT_TEMPLATE } from "../src/routes/closeout.js";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let ownerId: string;
let orgId: string;
let projectId: string;
let P: string;

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId, userId: ownerId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("action plans", () => {
  it("seeds a closeout checklist, enforces required documents and tracks progress", async () => {
    const sub = await inviteAndJoin(app, owner, orgId, "mech@example.com", { projectId, projectRole: "subcontractor" });
    const plan = (await owner.post(`${P}/action-plans`, {
      title: "Project closeout", kind: "closeout", useCloseoutTemplate: true,
      items: [{ section: "Mechanical", title: "HVAC O&M manuals", assigneeId: sub.userId, requiresFile: true, dueDate: "2026-11-30" }],
    })).body;
    let d = (await owner.get(`/api/action-plans/${plan.id}`)).body;
    expect(d.items).toHaveLength(CLOSEOUT_TEMPLATE.length + 1);
    expect(d.progress).toEqual({ complete: 0, total: CLOSEOUT_TEMPLATE.length + 1, percent: 0 });

    // The subcontractor sees only their own item and was notified.
    const mine = (await sub.client.get(`/api/action-plans/${plan.id}`)).body;
    expect(mine.items.map((i: { title: string }) => i.title)).toEqual(["HVAC O&M manuals"]);
    expect((await sub.client.get(`${P}/action-plans`)).body[0]).toMatchObject({ items: 1, complete: 0 });
    expect((await sub.client.get("/api/me/notifications")).body.items[0].title).toBe('You have items in "Project closeout"');
    const other = d.items.find((i: { title: string }) => i.title === "Punch list complete");
    expect((await sub.client.req("PATCH", `/api/action-plan-items/${other.id}`, { status: "done" })).status).toBe(404);

    const item = mine.items[0];
    expect((await sub.client.req("PATCH", `/api/action-plan-items/${item.id}`, { status: "done" })).status).toBe(400);
    const f = (await sub.client.upload(`${P}/files`, {}, { name: "hvac-om.pdf", type: "application/pdf", data: PDF("om") })).body;
    expect((await sub.client.post("/api/attachments", { entityType: "action_plan_item", entityId: item.id, fileId: f.id })).status).toBe(201);
    expect((await sub.client.req("PATCH", `/api/action-plan-items/${item.id}`, { status: "done", notes: "Uploaded" })).status).toBe(200);
    expect((await sub.client.req("PATCH", `/api/action-plan-items/${item.id}`, { dueDate: "2027-01-01" })).status).toBe(403);
    expect((await sub.client.req("PATCH", `/api/action-plan-items/${item.id}`, { status: "not_applicable" })).status).toBe(403);
    expect((await owner.req("PATCH", `/api/action-plan-items/${other.id}`, { status: "not_applicable" })).status).toBe(200);

    d = (await owner.get(`/api/action-plans/${plan.id}`)).body;
    expect(d.progress).toEqual({ complete: 2, total: 15, percent: 13 });
    expect(d.items.find((i: { id: string }) => i.id === item.id)).toMatchObject({ status: "done", files: 1, completed_by_name: "mech" });
    expect((await owner.get(`/api/action-plan-items/${item.id}/files`)).body[0].name).toBe("hvac-om.pdf");
  });

  it("copies a plan within the organization only", async () => {
    const src = (await owner.post(`${P}/action-plans`, { title: "QA", items: [{ title: "Slab flatness test" }, { title: "Rebar inspection", requiresFile: true }] })).body;
    const other = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Second job" })).body.id;
    const copy = (await owner.post(`/api/projects/${other}/action-plans`, { title: "QA copy", copyFromPlanId: src.id })).body;
    expect((await owner.get(`/api/action-plans/${copy.id}`)).body.items.map((i: { title: string; requires_file: boolean }) => [i.title, i.requires_file])).toEqual([["Slab flatness test", false], ["Rebar inspection", true]]);
    const outsider = await registerOwner(app, "x@example.com");
    const theirs = (await outsider.client.post(`/api/orgs/${outsider.orgId}/projects`, { name: "Theirs" })).body.id;
    expect((await outsider.client.post(`/api/projects/${theirs}/action-plans`, { title: "steal", copyFromPlanId: src.id })).status).toBe(400);
  });
});

describe("warranties", () => {
  it("flags expiring and expired warranties", async () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await owner.post(`${P}/warranties`, { item: "Roofing membrane", company: "TopRoof", startDate: day(-400), endDate: day(3000) });
    await owner.post(`${P}/warranties`, { item: "Rooftop units", company: "CoolAir", specSection: "23 74 13", startDate: day(-330), endDate: day(30) });
    await owner.post(`${P}/warranties`, { item: "Paint", company: "Brush Co", startDate: day(-500), endDate: day(-1) });
    expect((await owner.post(`${P}/warranties`, { item: "x", company: "y", startDate: day(5), endDate: day(1) })).status).toBe(400);
    const list = (await owner.get(`${P}/warranties`)).body;
    expect(list.map((w: { item: string; state: string }) => [w.item, w.state])).toEqual([["Paint", "expired"], ["Rooftop units", "expiring"], ["Roofing membrane", "active"]]);
    const sub = await inviteAndJoin(app, owner, orgId, "s@example.com", { projectId, projectRole: "subcontractor" });
    expect((await sub.client.get(`${P}/warranties`)).status).toBe(403);
  });
});

describe("coordination issues", () => {
  it("raises issues from a clash run once, and runs the review workflow", async () => {
    const { ifcWithBoxes } = await import("./ifc-fixture.js");
    const M = `${P}/models`;
    const a = (await owner.upload(M, { name: "Structure" }, { name: "s.ifc", type: "application/octet-stream", data: ifcWithBoxes([{ name: "Beam B1", x: 0, y: 0, z: 3, dx: 6, dy: 0.3, dz: 0.5 }]) })).body;
    const b = (await owner.upload(M, { name: "MEP" }, { name: "m.ifc", type: "application/octet-stream", data: ifcWithBoxes([{ type: "IFCDUCTSEGMENT", name: "Duct D1", x: 2, y: -1, z: 3.1, dx: 0.4, dy: 3, dz: 0.3 }]) })).body;
    const run = (await owner.post(`${P}/clashes`, { modelAId: a.modelId, modelBId: b.modelId })).body;
    const mech = await inviteAndJoin(app, owner, orgId, "mech@example.com", { projectId, projectRole: "subcontractor" });

    const r1 = (await owner.post(`/api/clash-runs/${run.id}/issues`, { indexes: [0], assigneeId: mech.userId, priority: "high" })).body;
    expect(r1.created).toBe(1);
    expect((await owner.post(`/api/clash-runs/${run.id}/issues`, { indexes: [0] })).body.created).toBe(0);
    expect((await owner.post(`/api/clash-runs/${run.id}/issues`, { indexes: [5] })).status).toBe(400);
    const issue = (await owner.get(`/api/coordination-issues/${r1.issues[0].id}`)).body;
    expect(issue).toMatchObject({ number: 1, title: "Beam B1 (BuildingElementProxy) × Duct D1 (DuctSegment)", type: "clash", priority: "high", assignee_id: mech.userId });
    expect(issue.elements.map((e: { name: string }) => e.name)).toEqual(["Beam B1", "Duct D1"]);

    // The assignee works it and sends it for review; only the author or a manager closes it.
    expect((await mech.client.req("PATCH", `/api/coordination-issues/${issue.id}`, { status: "ready_for_review" })).status).toBe(200);
    expect((await mech.client.req("PATCH", `/api/coordination-issues/${issue.id}`, { status: "closed" })).status).toBe(403);
    expect((await mech.client.req("PATCH", `/api/coordination-issues/${issue.id}`, { title: "renamed" })).status).toBe(403);
    expect((await owner.get("/api/me/notifications")).body.items[0].title).toBe("A coordination issue is ready for review");
    expect((await owner.req("PATCH", `/api/coordination-issues/${issue.id}`, { status: "closed" })).status).toBe(200);
    expect((await owner.get(`/api/coordination-issues/${issue.id}`)).body).toMatchObject({ status: "closed", priority: "high", type: "clash" });
    expect((await owner.get(`/api/coordination-issues/${issue.id}`)).body.closed_at).toBeTruthy();

    // A different subcontractor cannot see it.
    const elec = await inviteAndJoin(app, owner, orgId, "elec@example.com", { projectId, projectRole: "subcontractor" });
    expect((await elec.client.get(`${P}/coordination-issues`)).body).toEqual([]);
    expect((await elec.client.get(`/api/coordination-issues/${issue.id}`)).status).toBe(404);
    expect((await mech.client.get(`${P}/coordination-issues`)).body).toHaveLength(1);
  });

  it("creates manual issues and rejects assignees from outside the project", async () => {
    const outsider = await registerOwner(app, "x@example.com");
    expect((await owner.post(`${P}/coordination-issues`, { title: "Missing slab edge dims", type: "missing_information", assigneeId: outsider.userId })).status).toBe(400);
    const i = (await owner.post(`${P}/coordination-issues`, { title: "Missing slab edge dims", type: "missing_information", location: "L4 east" })).body;
    expect(i.number).toBe(1);
  });
});

describe("payroll export", () => {
  it("splits weekly overtime past 40 hours and flags re-exports", async () => {
    const worker = await inviteAndJoin(app, owner, orgId, "w@example.com", { projectId, projectRole: "contributor" });
    // Mon 2026-10-05 … Sat 2026-10-10: 9 h × 5 days + 6 h Saturday = 51 h → 11 h overtime.
    const days = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];
    for (const [i, d] of days.entries()) {
      const e = (await worker.client.post(`${P}/timesheets`, { workDate: d, hours: i === 5 ? "6" : "9" })).body;
      await owner.post(`/api/timesheets/${e.id}/decide`, { decision: "approved" });
    }
    const next = (await worker.client.post(`${P}/timesheets`, { workDate: "2026-10-12", hours: "8" })).body;
    await owner.post(`/api/timesheets/${next.id}/decide`, { decision: "approved" });
    const pending = (await worker.client.post(`${P}/timesheets`, { workDate: "2026-10-13", hours: "8" })).body;
    expect(pending.status).toBe("submitted");

    const r = (await owner.get(`${P}/timesheets/payroll?from=2026-10-01&to=2026-10-31`)).body;
    expect(r.rows.map((x: { work_date: string; regular: string; overtime: string }) => [x.work_date, x.regular, x.overtime])).toEqual([
      ["2026-10-05", "9.00", "0.00"], ["2026-10-06", "9.00", "0.00"], ["2026-10-07", "9.00", "0.00"], ["2026-10-08", "9.00", "0.00"],
      ["2026-10-09", "4.00", "5.00"], ["2026-10-10", "0.00", "6.00"], ["2026-10-12", "8.00", "0.00"],
    ]);
    const csv = await owner.raw(`${P}/timesheets/payroll.csv?from=2026-10-01&to=2026-10-31`);
    expect(csv.body.split("\r\n")[0]).toBe("Employee,Email,Week of,Date,Cost code,Hours,Regular,Overtime,Previously exported");
    expect((await owner.post(`${P}/timesheets/mark-exported`, { from: "2026-10-01", to: "2026-10-31" })).body.marked).toBe(7);
    expect((await owner.post(`${P}/timesheets/mark-exported`, { from: "2026-10-01", to: "2026-10-31" })).body.marked).toBe(0);
    expect((await owner.get(`${P}/timesheets/payroll?from=2026-10-01&to=2026-10-31`)).body.alreadyExported).toBe(7);
    expect((await worker.client.get(`${P}/timesheets/payroll?from=2026-10-01&to=2026-10-31`)).status).toBe(403);
    expect((await owner.get(`${P}/timesheets/payroll?from=2026-10-31&to=2026-10-01`)).status).toBe(400);
    void ownerId;
  });
});
