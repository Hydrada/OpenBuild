import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthsBetween, spread } from "../src/lib/cashflow.js";
import { sum } from "../src/lib/money.js";
import { Client, makeApp, registerOwner, type App, type Db } from "./helpers.js";

describe("spreading", () => {
  it("covers inclusive months across a year end", () => {
    expect(monthsBetween("2026-11-15", "2027-02-01")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });

  it("splits to the cent with the remainder in the last month, shaped by the curve", () => {
    expect(spread("100.00", "linear", 3)).toEqual(["33.33", "33.33", "33.34"]);
    for (const curve of ["linear", "front", "back", "s_curve"] as const) {
      const parts = spread("123456.78", curve, 7);
      expect(sum(parts).toFixed(2)).toBe("123456.78");
    }
    const front = spread("1000.00", "front", 4).map(Number), back = spread("1000.00", "back", 4).map(Number), s = spread("1000.00", "s_curve", 5).map(Number);
    expect(front[0]! > front[3]!).toBe(true);
    expect(back[3]! > back[0]!).toBe(true);
    expect(s[2]! > s[0]! && s[2]! > s[4]!).toBe(true);
    expect(spread("0.00", "linear", 3)).toEqual(["0.00", "0.00", "0.00"]);
  });
});

let app: App;
let db: Db;
let owner: Client;
let P: string;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  const o = await registerOwner(app);
  owner = o.client;
  const projectId = (await owner.post(`/api/orgs/${o.orgId}/projects`, { name: "Harbor Tower", startDate: "2026-09-01", endDate: "2026-12-31" })).body.id;
  P = `/api/projects/${projectId}`;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("cash flow", () => {
  it("forecasts each code's estimate at completion over its months and puts approved costs in their month", async () => {
    await owner.post(`${P}/cost-codes`, { csv: "code,description\n01-500,General conditions\n03-300,Concrete\n" });
    const cc = Object.fromEntries(((await owner.get(`${P}/cost-codes`)).body as { id: string; code: string }[]).map((c) => [c.code, c.id]));
    await owner.req("PUT", `${P}/budget/lines/${cc["01-500"]}`, { originalAmount: "12000.00" });
    await owner.req("PUT", `${P}/budget/lines/${cc["03-300"]}`, { originalAmount: "90000.00" });
    expect((await owner.req("PUT", `${P}/budget/lines/${cc["03-300"]}/spread`, { start: "2026-10", end: "2026-09", curve: "linear" })).status).toBe(400);
    expect((await owner.req("PUT", `${P}/budget/lines/${cc["03-300"]}/spread`, { start: "2026-10", end: "2026-12", curve: "front" })).status).toBe(200);
    const dc = (await owner.post(`${P}/direct-costs`, { kind: "expense", costDate: "2026-09-15", description: "Trailer", costCodeId: cc["01-500"], amount: "2500.00" })).body;

    const c = (await owner.get(`${P}/cash-flow`)).body;
    expect(c.months).toEqual(["2026-09", "2026-10", "2026-11", "2026-12"]);
    const gc = c.rows.find((r: { cost_code: string }) => r.cost_code === "01-500");
    // No spread set: the project dates, linear.
    expect(gc.forecast).toEqual({ "2026-09": "3000.00", "2026-10": "3000.00", "2026-11": "3000.00", "2026-12": "3000.00" });
    expect(gc.actual).toEqual({}); // pending costs are not actuals
    const conc = c.rows.find((r: { cost_code: string }) => r.cost_code === "03-300");
    expect(Object.keys(conc.forecast)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(Number(conc.forecast["2026-10"])).toBeGreaterThan(Number(conc.forecast["2026-12"]));
    expect(sum(Object.values(conc.forecast) as string[]).toFixed(2)).toBe("90000.00");
    expect(c.totals[c.totals.length - 1].cumulative_forecast).toBe("102000.00");

    // Approval makes it an actual in its month (the author cannot approve their own cost, so approve it directly).
    await db.query("UPDATE direct_costs SET status = 'approved' WHERE id = $1", [dc.id]);
    const after = (await owner.get(`${P}/cash-flow`)).body;
    expect(after.rows.find((r: { cost_code: string }) => r.cost_code === "01-500").actual).toEqual({ "2026-09": "2500.00" });
    expect(after.totals[0]).toMatchObject({ month: "2026-09", actual: "2500.00", cumulative_actual: "2500.00" });
    const csv = await owner.raw(`${P}/cash-flow.csv`);
    expect(csv.body.split("\r\n")[0]).toBe("Cost code,Description,Series,2026-09,2026-10,2026-11,2026-12");
  });
});
