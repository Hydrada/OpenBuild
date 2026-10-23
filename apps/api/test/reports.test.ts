import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let tower: string;
let school: string;
let pm: { client: Client; userId: string };

beforeAll(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  tower = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  school = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Elm School" })).body.id;
  pm = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId: tower, projectRole: "manager" });
  for (const [p, subject, assignee] of [[tower, "Beam depth", pm.userId], [tower, "Slab edge", null], [school, "Gym roof", null]] as const) {
    await owner.post(`/api/projects/${p}/rfis`, { subject, question: "?", assigneeId: assignee ?? undefined });
  }
  await owner.post(`/api/projects/${tower}/cost-codes`, { code: "01-500", description: "GC" });
  const cc = (await owner.get(`/api/projects/${tower}/cost-codes`)).body[0].id;
  for (const amount of ["100.10", "200.20", "0.05"]) {
    await owner.post(`/api/projects/${tower}/direct-costs`, { kind: amount === "0.05" ? "invoice" : "expense", costDate: "2026-10-01", description: "x", costCodeId: cc, amount });
  }
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const run = (c: Client, body: object) => c.post(`/api/orgs/${orgId}/reports/run`, body);

describe("report builder", () => {
  it("every dataset runs with every column", async () => {
    const datasets = (await owner.get("/api/reports/datasets")).body as { key: string; columns: { key: string }[]; statuses: string[] }[];
    expect(datasets.length).toBeGreaterThanOrEqual(10);
    for (const d of datasets) {
      const r = await run(owner, { dataset: d.key, config: { columns: d.columns.map((c) => c.key), statuses: d.statuses.slice(0, 1), from: "2020-01-01", to: "2030-01-01", text: "a", sort: d.columns[1]!.key, sortDesc: true } });
      expect(r.status, `${d.key}: ${JSON.stringify(r.body)}`).toBe(200);
    }
  });

  it("reports across every project the user can read, or one project", async () => {
    const all = (await run(owner, { dataset: "rfis", config: { columns: ["project", "subject"], sort: "subject" } })).body;
    expect(all.rows.map((r: { project: string; subject: string }) => `${r.project}: ${r.subject}`)).toEqual(["Harbor Tower: Beam depth", "Elm School: Gym roof", "Harbor Tower: Slab edge"]);
    // The project manager only belongs to the tower.
    const theirs = (await run(pm.client, { dataset: "rfis", config: { columns: ["subject"] } })).body.rows;
    expect(theirs.map((r: { subject: string }) => r.subject).sort()).toEqual(["Beam depth", "Slab edge"]);
    expect((await run(pm.client, { dataset: "rfis", projectId: school, config: { columns: ["subject"] } })).status).toBe(404);
    const assigned = (await run(owner, { dataset: "rfis", projectId: tower, config: { columns: ["subject", "assignee"], assigneeId: pm.userId } })).body.rows;
    expect(assigned).toEqual([{ subject: "Beam depth", assignee: "pm" }]);
  });

  it("groups and totals money exactly", async () => {
    const r = (await run(owner, { dataset: "direct_costs", config: { columns: ["kind", "amount"], groupBy: "kind", sumColumn: "amount" } })).body;
    expect(r.groups).toEqual([{ key: "expense", count: 2, total: "300.30" }, { key: "invoice", count: 1, total: "0.05" }]);
    expect(r.total).toBe("300.35");
    expect(r.rows.every((x: { amount: string }) => /^\d+\.\d{2}$/.test(x.amount))).toBe(true);
  });

  it("rejects anything outside the whitelist", async () => {
    expect((await run(owner, { dataset: "rfis", config: { columns: ["subject; DROP TABLE rfis"] } })).status).toBe(400);
    expect((await run(owner, { dataset: "rfis", config: { columns: ["subject"], statuses: ["open' OR '1'='1"] } })).status).toBe(400);
    expect((await run(owner, { dataset: "rfis", config: { columns: ["subject"], sumColumn: "subject" } })).status).toBe(400);
    expect((await run(owner, { dataset: "users", config: { columns: ["email"] } })).status).toBe(400);
    expect((await run(owner, { dataset: "incidents", config: { columns: ["title"], assigneeId: pm.userId } })).status).toBe(400);
    const outsider = await registerOwner(app, "x@example.com");
    expect((await outsider.client.post(`/api/orgs/${orgId}/reports/run`, { dataset: "rfis", config: { columns: ["subject"] } })).status).toBe(404);
  });

  it("saves private and shared reports and exports CSV", async () => {
    const mine = (await owner.post(`/api/orgs/${orgId}/reports`, { name: "Open RFIs", dataset: "rfis", config: { columns: ["project", "number", "subject"], statuses: ["open"] } })).body;
    const shared = (await owner.post(`/api/orgs/${orgId}/reports`, { name: "Tower costs", dataset: "direct_costs", projectId: tower, shared: true, config: { columns: ["description", "amount"], sumColumn: "amount" } })).body;
    expect((await pm.client.get(`/api/orgs/${orgId}/reports`)).body.map((r: { name: string }) => r.name)).toEqual(["Tower costs"]);
    expect((await pm.client.get(`/api/reports/${mine.id}`)).status).toBe(404);
    const got = (await pm.client.get(`/api/reports/${shared.id}`)).body;
    expect(got.result.total).toBe("300.35");
    expect((await pm.client.patch(`/api/reports/${shared.id}`, { name: "hijack" })).status).toBe(403);
    const csv = await owner.raw(`/api/reports/${mine.id}/csv`);
    expect(csv.headers["content-disposition"]).toContain('filename="Open_RFIs.csv"');
    expect(csv.body.split("\r\n")[0]).toBe("Project,#,Subject");
    expect(csv.body.split("\r\n").filter(Boolean)).toHaveLength(4);
    expect((await owner.req("DELETE", `/api/reports/${mine.id}`)).status).toBe(200);
  });
});
