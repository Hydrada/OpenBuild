import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolForRoute } from "../src/lib/tools.js";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;
let member: { client: Client; userId: string };

beforeAll(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
  member = await inviteAndJoin(app, owner, orgId, "field@example.com", { projectId, projectRole: "contributor" });
  await owner.post(`${P}/rfis`, { subject: "Beam depth", question: "?" });
  await owner.post(`${P}/cost-codes`, { code: "01", description: "GC" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("permission templates", () => {
  it("maps routes to tools", () => {
    expect(toolForRoute("/api/projects/:projectId/rfis")).toBe("rfis");
    expect(toolForRoute("/api/rfis/:id/responses")).toBe("rfis");
    expect(toolForRoute("/api/invoices/:id/pdf")).toBe("commitments");
    expect(toolForRoute("/api/projects/:projectId/members")).toBeNull();
  });

  it("none hides a tool, read blocks writes, admin elevates — for that tool only", async () => {
    const t = await owner.post(`/api/orgs/${orgId}/permission-templates`, { name: "Field engineer", levels: { budget: "none", rfis: "read", punch: "admin" } });
    expect(t.status).toBe(201);
    expect((await member.client.post(`/api/orgs/${orgId}/permission-templates`, { name: "x", levels: {} })).status).toBe(403);
    expect((await owner.post(`/api/orgs/${orgId}/permission-templates`, { name: "bad", levels: { rfis: "god" } })).status).toBe(400);

    // Before: standard contributor access.
    expect((await member.client.get(`${P}/budget`)).status).toBe(200);
    expect((await owner.req("PUT", `${P}/members/${member.userId}/template`, { templateId: t.body.id })).status).toBe(200);

    const budget = await member.client.get(`${P}/budget`);
    expect(budget.status).toBe(403);
    expect(budget.body.error).toBe("You do not have access to Budget, cost codes and direct costs");
    expect((await member.client.get(`${P}/rfis`)).status).toBe(200);
    expect((await member.client.post(`${P}/rfis`, { subject: "x", question: "y" })).status).toBe(403);
    // Admin on punch: a contributor may now close items (a manager action).
    const p = (await member.client.post(`${P}/punch-items`, { title: "Patch wall" })).body;
    expect((await member.client.post(`/api/punch-items/${p.id}/status`, { status: "closed" })).status).toBe(200);
    // Untouched tools stay standard.
    expect((await member.client.post(`${P}/observations`, { type: "safety", title: "o" })).status).toBe(201);

    // Search and reports respect "none"; RFIs (read) still appear.
    const dc = (await owner.post(`${P}/direct-costs`, { kind: "expense", costDate: "2026-10-01", description: "Beam rental", costCodeId: (await owner.get(`${P}/cost-codes`)).body[0].id, amount: "5" })).body;
    expect(dc.id).toBeTruthy();
    expect((await member.client.get(`${P}/search?q=beam`)).body.results.map((r: { kind: string }) => r.kind)).toEqual(["rfi"]);
    expect((await member.client.post(`/api/orgs/${orgId}/reports/run`, { dataset: "direct_costs", config: { columns: ["description"] } })).body.rows).toEqual([]);
    expect((await member.client.post(`/api/orgs/${orgId}/reports/run`, { dataset: "rfis", config: { columns: ["subject"] } })).body.rows).toHaveLength(1);

    const mine = (await member.client.get(`${P}/my-tools`)).body;
    expect(mine).toMatchObject({ budget: "none", rfis: "read", punch: "admin", drawings: "standard" });
    // Company admins are never restricted.
    expect((await owner.get(`${P}/my-tools`)).body.budget).toBe("standard");

    // Removing the template restores the role.
    await owner.req("PUT", `${P}/members/${member.userId}/template`, { templateId: null });
    expect((await member.client.get(`${P}/budget`)).status).toBe(200);
  });

  it("templates stay inside their company", async () => {
    const t = (await owner.post(`/api/orgs/${orgId}/permission-templates`, { name: "Viewer-ish", levels: {} })).body;
    const other = await registerOwner(app, "x@example.com");
    expect((await other.client.patch(`/api/permission-templates/${t.id}`, { name: "hijack" })).status).toBe(404);
    const theirProject = (await other.client.post(`/api/orgs/${other.orgId}/projects`, { name: "Theirs" })).body.id;
    expect((await other.client.req("PUT", `/api/projects/${theirProject}/members/${other.userId}/template`, { templateId: t.id })).status).toBe(400);
  });
});
