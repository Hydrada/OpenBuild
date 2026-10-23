import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pctOf } from "../src/lib/money.js";
import { parseCostCodeCsv } from "../src/routes/financials.js";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let ownerId: string;
let projectId: string;
let cc: Record<string, string>;

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId, userId: ownerId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  const imp = await owner.post(`/api/projects/${projectId}/cost-codes`, { csv: "code,description\n03-300,Cast-in-place concrete\n05-120,Structural steel\n\"01-500\",\"General conditions\"\n" });
  expect(imp.body).toEqual({ created: 3, skipped: 0 });
  const codes = (await owner.get(`/api/projects/${projectId}/cost-codes`)).body as { id: string; code: string }[];
  cc = Object.fromEntries(codes.map((c) => [c.code, c.id]));
});
afterEach(async () => {
  await app.close();
  await db.close();
});

async function approveViaSteps(client: Client, path: string) {
  const d = (await client.get(path)).body;
  const step = d.approvals.find((a: { status: string }) => a.status === "pending");
  return client.post(`/api/approval-steps/${step.id}/decide`, { decision: "approved" });
}

describe("money helpers", () => {
  it("rounds half-even and parses strictly", () => {
    expect(pctOf("0.25", "10").toFixed(2)).toBe("0.02");
    expect(pctOf("0.35", "10").toFixed(2)).toBe("0.04");
    expect(pctOf("255000.01", "10").toFixed(2)).toBe("25500.00");
    expect(parseCostCodeCsv("code,description\n1,A\n")).toEqual([{ code: "1", description: "A" }]);
  });
});

describe("budget, commitments, change orders and pay applications", () => {
  it("produces the expected budget report and AIA pay application figures", async () => {
    // Budget
    await owner.put(`/api/projects/${projectId}/budget/lines/${cc["03-300"]}`, { originalAmount: "500,000.00" });
    await owner.put(`/api/projects/${projectId}/budget/lines/${cc["05-120"]}`, { originalAmount: 300000 });
    await owner.put(`/api/projects/${projectId}/budget/lines/${cc["01-500"]}`, { originalAmount: "100000" });
    expect((await owner.put(`/api/projects/${projectId}/budget/lines/${cc["01-500"]}`, { originalAmount: "1.005" })).status).toBe(400);
    expect((await owner.post(`/api/projects/${projectId}/budget/lock`)).status).toBe(200);
    expect((await owner.put(`/api/projects/${projectId}/budget/lines/${cc["01-500"]}`, { originalAmount: "1" })).status).toBe(409);
    await owner.post(`/api/projects/${projectId}/budget/modifications`, { fromCostCodeId: cc["01-500"], toCostCodeId: cc["03-300"], amount: "10000", reason: "Winter protection" });

    // Contracts
    const prime = (await owner.post(`/api/projects/${projectId}/contracts`, {
      kind: "prime", title: "Owner agreement", counterparty: "Harbor Owner LLC", retainagePercent: 5,
      lines: [{ costCodeId: cc["03-300"], description: "Concrete", amount: "520000" }, { costCodeId: cc["05-120"], description: "Steel", amount: "320000" }, { costCodeId: cc["01-500"], description: "GCs", amount: "110000" }],
    })).body;
    expect((await owner.post(`/api/projects/${projectId}/contracts`, { kind: "prime", title: "x", counterparty: "y" })).status).toBe(409);
    const sub = (await owner.post(`/api/projects/${projectId}/contracts`, { kind: "subcontract", title: "Concrete package", counterparty: "Acme Concrete", retainagePercent: "10", lines: [{ costCodeId: cc["03-300"], description: "Foundations and decks", amount: "480000.00" }] })).body;
    const po = (await owner.post(`/api/projects/${projectId}/contracts`, { kind: "purchase_order", title: "Steel supply", counterparty: "Steel Co", lines: [{ costCodeId: cc["05-120"], description: "Fabricated steel", amount: "290000.33" }] })).body;
    for (const k of [prime, sub, po]) expect((await owner.post(`/api/contracts/${k.id}/status`, { status: "approved" })).status).toBe(200);
    expect((await owner.patch(`/api/contracts/${sub.id}`, { title: "x" })).status).toBe(409);

    // Change event, then change orders on both sides
    const ce = (await owner.post(`/api/projects/${projectId}/change-events`, { title: "Unforeseen rock", reason: "unforeseen_condition", scope: "out_of_scope", lines: [{ costCodeId: cc["03-300"], description: "Rock removal", estimatedCost: "25000", estimatedRevenue: "30000" }] })).body;
    let budget = (await owner.get(`/api/projects/${projectId}/budget`)).body;
    expect(budget.rows.find((r: { cost_code: string }) => r.cost_code === "03-300").change_event_exposure).toBe("25000.00");

    const pco = (await owner.post(`/api/projects/${projectId}/change-orders`, { contractId: prime.id, changeEventId: ce.id, title: "Rock removal (owner)", lines: [{ costCodeId: cc["03-300"], description: "Rock removal", amount: "30000" }] })).body;
    const sco = (await owner.post(`/api/projects/${projectId}/change-orders`, { contractId: sub.id, changeEventId: ce.id, title: "Rock removal (sub)", lines: [{ costCodeId: cc["03-300"], description: "Rock removal", amount: "24500" }] })).body;
    expect((await owner.post(`/api/change-orders/${pco.id}/submit`, { approverIds: [ownerId] })).status).toBe(200);
    expect((await approveViaSteps(owner, `/api/change-orders/${pco.id}`)).body.outcome).toBe("approved");
    expect((await owner.post(`/api/change-orders/${sco.id}/submit`, { approverIds: [ownerId] })).status).toBe(200); // pending

    budget = (await owner.get(`/api/projects/${projectId}/budget`)).body;
    const row = (code: string) => budget.rows.find((r: { cost_code: string }) => r.cost_code === code);
    expect(row("03-300")).toMatchObject({
      original_budget: "500000.00", budget_modifications: "10000.00", approved_changes: "30000.00", revised_budget: "540000.00",
      committed_costs: "480000.00", pending_cost_changes: "24500.00", change_event_exposure: "0.00",
      estimated_cost_at_completion: "540000.00", projected_over_under: "0.00",
    });
    expect(row("01-500")).toMatchObject({ budget_modifications: "-10000.00", revised_budget: "90000.00" });
    expect(row("05-120")).toMatchObject({ committed_costs: "290000.33", estimated_cost_at_completion: "300000.00" });
    await owner.put(`/api/projects/${projectId}/budget/lines/${cc["05-120"]}`, { forecastToComplete: "15000.10" });
    budget = (await owner.get(`/api/projects/${projectId}/budget`)).body;
    expect(row("05-120")).toMatchObject({ estimated_cost_at_completion: "305000.43", projected_over_under: "-5000.43" });
    expect(budget.totals.revised_budget).toBe("930000.00");
    expect(budget.locked).toBe(true);

    // Pay application #1 on the subcontract (10% retainage)
    const inv1 = (await owner.post(`/api/projects/${projectId}/invoices`, { contractId: sub.id, periodStart: "2026-09-01", periodEnd: "2026-09-30" })).body;
    expect((await owner.post(`/api/projects/${projectId}/invoices`, { contractId: sub.id, periodStart: "2026-10-01", periodEnd: "2026-10-31" })).status).toBe(409);
    let pa = (await owner.get(`/api/invoices/${inv1.id}`)).body;
    expect(pa.lines).toHaveLength(1); // pending CO not in the schedule of values yet
    const key = pa.lines[0].key;
    pa = (await owner.put(`/api/invoices/${inv1.id}/lines`, { lines: [{ key, workThisPeriod: "100000", materialsStored: "20000" }] })).body;
    expect(pa.totals).toMatchObject({ completed_to_date: "120000.00", retainage: "12000.00", earned_less_retainage: "108000.00", previous_certificates: "0.00", current_payment_due: "108000.00" });
    await owner.post(`/api/invoices/${inv1.id}/submit`, { approverIds: [ownerId] });
    expect((await approveViaSteps(owner, `/api/invoices/${inv1.id}`)).body.outcome).toBe("approved");

    // Approve the sub CO; it joins the schedule of values
    expect((await approveViaSteps(owner, `/api/change-orders/${sco.id}`)).body.outcome).toBe("approved");

    // Pay application #2
    const inv2 = (await owner.post(`/api/projects/${projectId}/invoices`, { contractId: sub.id, periodStart: "2026-10-01", periodEnd: "2026-10-31" })).body;
    pa = (await owner.get(`/api/invoices/${inv2.id}`)).body;
    expect(pa.lines.map((l: { source: string }) => l.source)).toEqual(["Original contract", `CO #${sco.number}`]);
    pa = (await owner.put(`/api/invoices/${inv2.id}/lines`, { lines: [
      { key: pa.lines[0].key, workThisPeriod: "150000.01", materialsStored: "5000" },
      { key: pa.lines[1].key, workThisPeriod: "10000" },
    ] })).body;
    expect(pa.lines[0]).toMatchObject({ previous_work: "100000.00", completed_to_date: "255000.01", retainage: "25500.00", balance_to_finish: "224999.99" });
    expect(pa.totals).toMatchObject({
      original_contract_sum: "480000.00", net_change_by_change_orders: "24500.00", contract_sum_to_date: "504500.00",
      completed_to_date: "265000.01", retainage: "26500.00", earned_less_retainage: "238500.01",
      previous_certificates: "108000.00", current_payment_due: "130500.01", balance_to_finish_including_retainage: "265999.99",
    });
    await owner.post(`/api/invoices/${inv2.id}/submit`, { approverIds: [ownerId] });
    await approveViaSteps(owner, `/api/invoices/${inv2.id}`);
    expect((await owner.post(`/api/invoices/${inv2.id}/paid`)).status).toBe(200);

    // Direct costs: all work billed + only the latest stored-materials balance
    budget = (await owner.get(`/api/projects/${projectId}/budget`)).body;
    expect(row("03-300").direct_costs).toBe("265000.01");

    // Over-billing is refused
    const inv3 = (await owner.post(`/api/projects/${projectId}/invoices`, { contractId: sub.id, periodStart: "2026-11-01", periodEnd: "2026-11-30" })).body;
    pa = (await owner.get(`/api/invoices/${inv3.id}`)).body;
    await owner.put(`/api/invoices/${inv3.id}/lines`, { lines: [{ key: pa.lines[1].key, workThisPeriod: "14500.01" }] });
    const over = await owner.post(`/api/invoices/${inv3.id}/submit`, { approverIds: [ownerId] });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/exceeds the scheduled value/);
    expect((await owner.del(`/api/invoices/${inv3.id}`)).status).toBe(200);

    // Exports
    const csv = await owner.raw(`/api/projects/${projectId}/budget.csv`);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body.split("\r\n")[0]).toMatch(/^Cost code,Description,Original budget/);
    expect(csv.body).toContain("TOTAL,,900000.00");
    const g703 = await owner.raw(`/api/invoices/${inv2.id}/g703.csv`);
    expect(g703.body).toContain("Current payment due,,130500.01");
  });

  it("enforces financial permissions and approver eligibility", async () => {
    const { client: contrib, userId: contribId } = await inviteAndJoin(app, owner, orgId, "c@example.com", { projectId, projectRole: "contributor" });
    const { client: viewer } = await inviteAndJoin(app, owner, orgId, "v@example.com", { projectId, projectRole: "viewer" });
    expect((await contrib.post(`/api/projects/${projectId}/contracts`, { kind: "subcontract", title: "x", counterparty: "y" })).status).toBe(403);
    expect((await contrib.put(`/api/projects/${projectId}/budget/lines/${cc["03-300"]}`, { originalAmount: "1" })).status).toBe(403);
    expect((await viewer.get(`/api/projects/${projectId}/budget`)).status).toBe(200);

    const k = (await owner.post(`/api/projects/${projectId}/contracts`, { kind: "subcontract", title: "Sub", counterparty: "S", lines: [{ costCodeId: cc["03-300"], description: "x", amount: "1000" }] })).body;
    expect((await contrib.post(`/api/projects/${projectId}/change-orders`, { contractId: k.id, title: "x", lines: [{ costCodeId: cc["03-300"], description: "x", amount: "1" }] })).status).toBe(409); // contract still draft
    await owner.post(`/api/contracts/${k.id}/status`, { status: "approved" });
    const co = (await contrib.post(`/api/projects/${projectId}/change-orders`, { contractId: k.id, title: "Extra", lines: [{ costCodeId: cc["03-300"], description: "x", amount: "-250.50" }] })).body;
    expect((await contrib.post(`/api/change-orders/${co.id}/submit`, { approverIds: [contribId] })).status).toBe(400); // contributor cannot approve money
    expect((await contrib.post(`/api/change-orders/${co.id}/submit`, { approverIds: [ownerId] })).status).toBe(200);
    const d = (await owner.get(`/api/change-orders/${co.id}`)).body;
    expect(d.total).toBe("-250.50");
    expect((await owner.post(`/api/approval-steps/${d.approvals[0].id}/decide`, { decision: "approved_as_noted" })).status).toBe(400);
    expect((await owner.post(`/api/approval-steps/${d.approvals[0].id}/decide`, { decision: "rejected", comment: "Need backup" })).body.outcome).toBe("rejected");
    expect((await owner.get(`/api/change-orders/${co.id}`)).body.status).toBe("rejected");
    expect((await contrib.post(`/api/change-orders/${co.id}/void`)).status).toBe(403);
    expect((await owner.post(`/api/change-orders/${co.id}/void`)).status).toBe(200);

    const otherProject = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Other" })).body.id;
    expect((await owner.post(`/api/projects/${otherProject}/contracts`, { kind: "subcontract", title: "x", counterparty: "y", lines: [{ costCodeId: cc["03-300"], description: "x", amount: "1" }] })).status).toBe(400);
  });
});
