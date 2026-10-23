import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;
let cc: Record<string, string>;

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
  await owner.post(`${P}/cost-codes`, { csv: "code,description\n03-300,Concrete\n01-500,General conditions\n" });
  cc = Object.fromEntries(((await owner.get(`${P}/cost-codes`)).body as { id: string; code: string }[]).map((c) => [c.code, c.id]));
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("correspondence", () => {
  it("numbers per kind, hides drafts and private items, and tracks acknowledgement", async () => {
    const pm = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
    const viewer = await inviteAndJoin(app, owner, orgId, "v@example.com", { projectId, projectRole: "viewer" });
    const sub = await inviteAndJoin(app, owner, orgId, "sub@example.com", { projectId, projectRole: "subcontractor" });
    const other = await inviteAndJoin(app, owner, orgId, "sub2@example.com", { projectId, projectRole: "subcontractor" });

    const t1 = (await owner.post(`${P}/correspondence`, { kind: "transmittal", subject: "Shop drawings set 1", recipientIds: [sub.userId] })).body;
    const t2 = (await owner.post(`${P}/correspondence`, { kind: "transmittal", subject: "Shop drawings set 2" })).body;
    const n1 = (await owner.post(`${P}/correspondence`, { kind: "notice", subject: "Notice of delay", private: true, recipientIds: [pm.userId] })).body;
    const draft = (await owner.post(`${P}/correspondence`, { kind: "letter", subject: "Draft letter", draft: true, recipientIds: [sub.userId] })).body;
    expect([t1.number, t2.number, n1.number, draft.number]).toEqual([1, 2, 1, 1]);

    // The subcontractor sees only the transmittal addressed to them; the draft is not sent yet.
    expect((await sub.client.get(`${P}/correspondence`)).body.map((c: { subject: string }) => c.subject)).toEqual(["Shop drawings set 1"]);
    expect((await other.client.get(`${P}/correspondence`)).body).toEqual([]);
    expect((await other.client.get(`/api/correspondence/${t1.id}`)).status).toBe(404);
    // Viewers do not see private notices they are not party to; managers do.
    expect((await viewer.client.get(`${P}/correspondence`)).body.map((c: { subject: string }) => c.subject).sort()).toEqual(["Shop drawings set 1", "Shop drawings set 2"]);
    expect((await viewer.client.get(`/api/correspondence/${n1.id}`)).status).toBe(404);
    expect((await pm.client.get(`/api/correspondence/${n1.id}`)).status).toBe(200);
    expect((await pm.client.get(`/api/correspondence/${draft.id}`)).status).toBe(404);

    expect((await owner.post(`/api/correspondence/${t1.id}/acknowledge`, {})).status).toBe(403);
    expect((await sub.client.post(`/api/correspondence/${t1.id}/acknowledge`, {})).status).toBe(200);
    const d = (await owner.get(`/api/correspondence/${t1.id}`)).body;
    expect(d.recipients[0].acknowledged_at).toBeTruthy();
    expect((await sub.client.post(`/api/correspondence/${t1.id}/status`, { status: "closed" })).status).toBe(403);

    // Sending the draft notifies its recipient.
    expect((await sub.client.get("/api/me/notifications")).body.items.some((n: { title: string }) => n.title.includes("Draft letter"))).toBe(false);
    expect((await owner.post(`/api/correspondence/${draft.id}/send`, {})).status).toBe(200);
    expect((await owner.post(`/api/correspondence/${draft.id}/send`, {})).status).toBe(409);
    expect((await sub.client.get("/api/me/notifications")).body.items.some((n: { title: string }) => n.title === "LTR-001: Draft letter")).toBe(true);
    expect((await owner.post(`/api/correspondence/${t1.id}/status`, { status: "closed" })).status).toBe(200);
    expect((await owner.get(`/api/correspondence/${t1.id}`)).body.status).toBe("closed");
  });

  it("rejects recipients outside the project", async () => {
    const outsider = await registerOwner(app, "x@example.com");
    expect((await owner.post(`${P}/correspondence`, { kind: "memo", subject: "x", recipientIds: [outsider.userId] })).status).toBe(400);
  });
});

describe("direct costs", () => {
  it("counts approved entries in the budget's direct costs and estimate at completion", async () => {
    await owner.put(`${P}/budget/lines/${cc["01-500"]}`, { originalAmount: "1000.00" });
    const pm = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
    const a = (await pm.client.post(`${P}/direct-costs`, { kind: "expense", costDate: "2026-10-01", vendor: "Home Depot", description: "Barricades", costCodeId: cc["01-500"], amount: "400.10" })).body;
    const b = (await pm.client.post(`${P}/direct-costs`, { kind: "payroll", costDate: "2026-10-02", description: "Laborer week 40", costCodeId: cc["01-500"], amount: "800.00" })).body;
    let row = (await owner.get(`${P}/budget`)).body.rows.find((r: { cost_code: string }) => r.cost_code === "01-500");
    expect(row).toMatchObject({ direct_costs: "0.00", estimated_cost_at_completion: "1000.00" });

    // Segregation of duties: the person who entered a cost cannot approve it.
    expect((await pm.client.post(`/api/direct-costs/${a.id}/status`, { status: "approved" })).status).toBe(403);
    expect((await owner.post(`/api/direct-costs/${a.id}/status`, { status: "approved" })).status).toBe(200);
    expect((await owner.post(`/api/direct-costs/${b.id}/status`, { status: "approved" })).status).toBe(200);
    row = (await owner.get(`${P}/budget`)).body.rows.find((r: { cost_code: string }) => r.cost_code === "01-500");
    expect(row).toMatchObject({ direct_costs: "1200.10", estimated_cost_at_completion: "1200.10", projected_over_under: "-200.10" });
    const list = (await owner.get(`${P}/direct-costs`)).body;
    expect(list).toMatchObject({ approvedTotal: "1200.10", pendingTotal: "0.00" });
    expect((await owner.req("DELETE", `/api/direct-costs/${a.id}`)).status).toBe(409);
  });

  it("rejects bad money and foreign cost codes", async () => {
    expect((await owner.post(`${P}/direct-costs`, { kind: "expense", costDate: "2026-10-01", description: "x", costCodeId: cc["01-500"], amount: "1.234" })).status).toBe(400);
    const other = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Other" })).body.id;
    expect((await owner.post(`/api/projects/${other}/direct-costs`, { kind: "expense", costDate: "2026-10-01", description: "x", costCodeId: cc["01-500"], amount: "1" })).status).toBe(400);
  });
});

describe("T&M tickets", () => {
  it("totals lines, needs a field signature, and becomes a change event once approved", async () => {
    const t = (await owner.post(`${P}/tm-tickets`, {
      workDate: "2026-10-05", description: "Extra core drilling at L2", company: "Acme Concrete",
      lines: [
        { category: "labor", description: "Carpenter", quantity: "6.5", unit: "hr", rate: "87.25", costCodeId: cc["03-300"] },
        { category: "material", description: "Grout", quantity: "3", unit: "bag", rate: "19.99", costCodeId: cc["03-300"] },
        { category: "equipment", description: "Core drill", quantity: "1", unit: "day", rate: "145", costCodeId: cc["01-500"] },
      ],
    })).body;
    let d = (await owner.get(`/api/tm-tickets/${t.id}`)).body;
    // 6.5 × 87.25 = 567.125 → 567.12 (half-even); 3 × 19.99 = 59.97; 145.00
    expect(d.lines.map((l: { amount: string }) => l.amount)).toEqual(["567.12", "59.97", "145.00"]);
    expect(d.subtotals).toEqual({ labor: "567.12", material: "59.97", equipment: "145.00" });
    expect(d.total).toBe("772.09");
    // The list agrees with the ticket (no half-away-from-zero drift from SQL rounding).
    expect((await owner.get(`${P}/tm-tickets`)).body[0].total).toBe("772.09");

    expect((await owner.post(`/api/tm-tickets/${t.id}/status`, { status: "approved" })).status).toBe(409);
    expect((await owner.post(`/api/tm-tickets/${t.id}/status`, { status: "submitted" })).status).toBe(400);
    expect((await owner.post(`/api/tm-tickets/${t.id}/change-event`, {})).status).toBe(409);
    d = (await owner.post(`/api/tm-tickets/${t.id}/status`, { status: "submitted", signedBy: "Sam Super (owner's rep)" })).body;
    expect(d).toMatchObject({ status: "submitted", signed_by: "Sam Super (owner's rep)" });
    expect((await owner.patch(`/api/tm-tickets/${t.id}`, { description: "changed" })).status).toBe(409);
    expect((await owner.post(`/api/tm-tickets/${t.id}/status`, { status: "approved" })).status).toBe(200);

    const ce = (await owner.post(`/api/tm-tickets/${t.id}/change-event`, {})).body;
    expect((await owner.post(`/api/tm-tickets/${t.id}/change-event`, {})).status).toBe(409);
    const events = (await owner.get(`${P}/change-events`)).body;
    expect(events.find((e: { id: string }) => e.id === ce.id)).toMatchObject({ title: "T&M ticket #1", estimated_cost: "772.09", estimated_revenue: "772.09" });
    expect((await owner.get(`/api/tm-tickets/${t.id}`)).body.change_event_number).toBe(ce.number);
  });

  it("contributors submit but cannot approve", async () => {
    const c = await inviteAndJoin(app, owner, orgId, "c@example.com", { projectId, projectRole: "contributor" });
    const t = (await c.client.post(`${P}/tm-tickets`, { workDate: "2026-10-05", description: "x", lines: [{ category: "labor", description: "x", quantity: 1, rate: "10" }] })).body;
    expect((await c.client.post(`/api/tm-tickets/${t.id}/status`, { status: "submitted", signedBy: "Owner rep" })).status).toBe(200);
    expect((await c.client.post(`/api/tm-tickets/${t.id}/status`, { status: "approved" })).status).toBe(403);
    expect((await owner.post(`/api/tm-tickets/${t.id}/status`, { status: "rejected" })).status).toBe(200);
    expect((await c.client.patch(`/api/tm-tickets/${t.id}`, { description: "fixed" })).status).toBe(200);
  });
});

describe("equipment", () => {
  it("logs daily hours with a 24-hour cap and reports operating cost", async () => {
    const e = (await owner.post(`${P}/equipment`, { name: "CAT 320 excavator", category: "Excavator", ownership: "rented", hourlyRate: "112.50" })).body;
    expect((await owner.post(`${P}/equipment`, { name: "cat 320 EXCAVATOR" })).status).toBe(409);
    expect((await owner.post(`/api/equipment/${e.id}/logs`, { logDate: "2026-10-05", hoursOperated: 7.5, hoursIdle: 1, costCodeId: cc["03-300"] })).status).toBe(201);
    expect((await owner.post(`/api/equipment/${e.id}/logs`, { logDate: "2026-10-05", hoursOperated: 16 })).status).toBe(400);
    expect((await owner.post(`/api/equipment/${e.id}/logs`, { logDate: "2026-10-06", hoursOperated: 2.25 })).status).toBe(201);
    const d = (await owner.get(`/api/equipment/${e.id}`)).body;
    expect(d).toMatchObject({ hoursOperated: "9.75", operatingCost: "1096.88" }); // 9.75 × 112.50 = 1096.875 → 1096.88
    const list = (await owner.get(`${P}/equipment`)).body;
    expect(list[0]).toMatchObject({ name: "CAT 320 excavator", hours_operated: "9.75", hours_idle: "1.00", last_used: "2026-10-06" });
    const sub = await inviteAndJoin(app, owner, orgId, "sub@example.com", { projectId, projectRole: "subcontractor" });
    expect((await sub.client.get(`${P}/equipment`)).status).toBe(403);
  });
});
