import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dec, sum } from "../src/lib/money.js";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;
let cc: Record<string, string>;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
  await owner.post(`${P}/cost-codes`, { csv: "code,description\n03-200,Rebar\n03-300,Concrete\n" });
  cc = Object.fromEntries(((await owner.get(`${P}/cost-codes`)).body as { id: string; code: string }[]).map((c) => [c.code, c.id]));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("estimating", () => {
  it("prices lines half-even, compounds markups, and sends the result to the budget", async () => {
    expect((await owner.post(`/api/orgs/${orgId}/cost-catalog`, { name: "Ready-mix 4000 psi", category: "material", unit: "CY", unitCost: "145.25" })).status).toBe(201);
    expect((await owner.get(`/api/orgs/${orgId}/cost-catalog`)).body[0]).toMatchObject({ name: "Ready-mix 4000 psi", unit_cost: "145.25" });

    const e = (await owner.post(`${P}/estimates`, { name: "GMP v1", overheadPct: "10", contingencyPct: "5", profitPct: "8", bondPct: "1" })).body;
    const d = (await owner.req("PUT", `/api/estimates/${e.id}`, { lines: [
      { costCodeId: cc["03-300"], description: "Slab concrete", category: "material", quantity: "88.5", unit: "CY", unitCost: "145.25" }, // 12854.625 -> 12854.62
      { costCodeId: cc["03-300"], description: "Formwork", category: "labor", quantity: "1200", unit: "SF", unitCost: "6.10" },        // 7320.00
      { costCodeId: cc["03-200"], description: "Rebar", category: "material", quantity: "4.25", unit: "TON", unitCost: "1875.50" },   // 7970.875 -> 7970.88
    ] })).body;
    expect(d.lines.map((l: { amount: string }) => l.amount)).toEqual(["12854.62", "7320.00", "7970.88"]);
    // direct 28145.50; overhead 10% 2814.55; contingency 5% 1407.275 -> 1407.28; profit 8% of 32367.33 = 2589.3864 -> 2589.39;
    // bond 1% of 34956.72 = 349.5672 -> 349.57; total 35306.29
    expect(d.totals).toEqual({ direct: "28145.50", overhead: "2814.55", contingency: "1407.28", profit: "2589.39", bond: "349.57", total: "35306.29" });
    expect(d.byCostCode.map((g: { cost_code: string; direct: string }) => [g.cost_code, g.direct])).toEqual([["03-200", "7970.88"], ["03-300", "20174.62"]]);
    // Markup is allocated by direct cost and the parts add back to the total to the cent.
    expect(sum(d.byCostCode.map((g: { with_markup: string }) => g.with_markup)).toFixed(2)).toBe("35306.29");

    expect((await owner.req("PUT", `/api/estimates/${e.id}`, { lines: [{ description: "x", quantity: "1.2345", unitCost: "1" }] })).status).toBe(400);
    const r = await owner.post(`/api/estimates/${e.id}/send-to-budget`, {});
    expect(r.body).toMatchObject({ total: "35306.29", costCodes: 2 });
    const budget = (await owner.get(`${P}/budget`)).body;
    expect(budget.totals.original_budget).toBe("35306.29");
    expect(dec(budget.rows.find((x: { cost_code: string }) => x.cost_code === "03-300").original_budget).gt(20174.62)).toBe(true);
    expect((await owner.req("PUT", `/api/estimates/${e.id}`, { name: "changed" })).status).toBe(409);
    const csv = await owner.raw(`/api/estimates/${e.id}/csv`);
    expect(csv.body).toContain("Total,,,,,35306.29");
  });

  it("needs cost codes on every line, a manager to send, and respects a locked budget", async () => {
    const c = await inviteAndJoin(app, owner, orgId, "est@example.com", { projectId, projectRole: "contributor" });
    const e = (await c.client.post(`${P}/estimates`, { name: "Alt" })).body;
    await c.client.req("PUT", `/api/estimates/${e.id}`, { lines: [{ description: "Uncoded", quantity: "1", unitCost: "10" }] });
    expect((await c.client.post(`/api/estimates/${e.id}/send-to-budget`, {})).status).toBe(403);
    expect((await owner.post(`/api/estimates/${e.id}/send-to-budget`, {})).body.error).toBe("Give every line a cost code first (1 without)");
    expect((await c.client.post(`/api/orgs/${orgId}/cost-catalog`, { name: "x", unit: "ea", unitCost: "1" })).status).toBe(403);
  });
});
