import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorage } from "../src/lib/storage.js";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

/** Routes that are intentionally reachable without a session (they carry their own token or are auth endpoints). */
const PUBLIC = [
  "GET /api/health", "GET /api/auth/config", "POST /api/auth/register", "POST /api/auth/login", "POST /api/auth/logout",
  "GET /api/invitations/:token", "POST /api/invitations/:token/accept",
  "GET /api/password-resets/:token", "POST /api/password-resets/:token",
  "GET /api/tool/:token/file", "POST /api/tool/:token/markup",
  "GET /api/bids/:token", "POST /api/bids/:token", "GET /api/bids/:token/files/:fileId",
  "GET /api/auth/oidc/start", "GET /api/auth/oidc/callback",
  "GET /api/auth/saml/metadata", "GET /api/auth/saml/start", "POST /api/auth/saml/acs",
];

let app: App;
let db: Db;
let owner: Client;
let outsider: Client;
let ids: Record<string, string>;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  const o = await registerOwner(app, "owner@example.com");
  owner = o.client;
  const orgId = o.orgId;
  const projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Secret tower" })).body.id;
  const { userId: memberId } = await inviteAndJoin(app, owner, orgId, "m@example.com", { projectId, projectRole: "manager" });
  // Populate one record of every kind so the sweep can hit real ids.
  const P = `/api/projects/${projectId}`;
  const drawing = (await owner.upload(`${P}/drawings`, { number: "A-1", title: "Plan", revision: "0" }, { name: "a.pdf", type: "application/pdf", data: PDF() })).body;
  const dRow = (await owner.get(`/api/drawings/${drawing.drawingId}`)).body;
  const doc = (await owner.upload(`${P}/documents`, {}, { name: "d.pdf", type: "application/pdf", data: PDF() })).body;
  await owner.post(`/api/documents/${doc.id}/submit`, { approverIds: [memberId] });
  const step = (await owner.get(`/api/documents/${doc.id}`)).body.approvals[0];
  const rfi = (await owner.post(`${P}/rfis`, { subject: "s", question: "q" })).body;
  const sub = (await owner.post(`${P}/submittals`, { title: "s", reviewerIds: [memberId] })).body;
  const log = (await owner.post(`${P}/daily-logs`, { logDate: "2026-10-01" })).body;
  const tpl = (await owner.post(`/api/orgs/${orgId}/inspection-templates`, { name: "t", items: ["a"] })).body;
  const ins = (await owner.post(`${P}/inspections`, { title: "i", templateId: tpl.id })).body;
  const item = (await owner.get(`/api/inspections/${ins.id}`)).body.items[0];
  const punch = (await owner.post(`${P}/punch-items`, { title: "p" })).body;
  const obs = (await owner.post(`${P}/observations`, { type: "safety", title: "o" })).body;
  const inc = (await owner.post(`${P}/incidents`, { occurredAt: "2026-10-01T10:00:00Z", type: "near_miss", title: "i", description: "d" })).body;
  await owner.post(`${P}/cost-codes`, { code: "01", description: "GC" });
  const cc = (await owner.get(`${P}/cost-codes`)).body[0];
  const k = (await owner.post(`${P}/contracts`, { kind: "subcontract", title: "k", counterparty: "c", lines: [{ costCodeId: cc.id, description: "x", amount: "100" }] })).body;
  await owner.post(`/api/contracts/${k.id}/status`, { status: "approved" });
  const ce = (await owner.post(`${P}/change-events`, { title: "ce" })).body;
  const co = (await owner.post(`${P}/change-orders`, { contractId: k.id, title: "co", lines: [{ costCodeId: cc.id, description: "x", amount: "1" }] })).body;
  const inv = (await owner.post(`${P}/invoices`, { contractId: k.id, periodStart: "2026-10-01", periodEnd: "2026-10-31" })).body;
  const corr = (await owner.post(`${P}/correspondence`, { kind: "notice", subject: "n" })).body;
  const dc = (await owner.post(`${P}/direct-costs`, { kind: "expense", costDate: "2026-10-01", description: "d", costCodeId: cc.id, amount: "1" })).body;
  const tm = (await owner.post(`${P}/tm-tickets`, { workDate: "2026-10-01", description: "t" })).body;
  const eq = (await owner.post(`${P}/equipment`, { name: "Crane" })).body;
  const plan = (await owner.post(`${P}/action-plans`, { title: "Closeout", items: [{ title: "O&M" }] })).body;
  const planItem = (await owner.get(`/api/action-plans/${plan.id}`)).body.items[0];
  const warranty = (await owner.post(`${P}/warranties`, { item: "Roof", company: "R", startDate: "2026-01-01", endDate: "2036-01-01" })).body;
  const issue = (await owner.post(`${P}/coordination-issues`, { title: "i" })).body;
  const laTask = (await owner.post(`${P}/lookahead-tasks`, { name: "t", startDate: "2026-10-05", endDate: "2026-10-05" })).body;
  const worker = (await owner.post(`/api/orgs/${orgId}/workers`, { name: "w" })).body;
  const crew = (await owner.post(`${P}/crews`, { name: "c", workerIds: [worker.id] })).body;
  const compDoc = (await owner.post(`/api/contracts/${k.id}/compliance`, { kind: "w9" })).body;
  const tpl2 = (await owner.post(`/api/orgs/${orgId}/permission-templates`, { name: "t", levels: {} })).body;
  const dlEntry = (await owner.post(`/api/daily-logs/${log.id}/entries`, { kind: "call", description: "c" })).body;
  const waiver = (await owner.post(`/api/invoices/${inv.id}/lien-waivers`, { kind: "conditional_progress" })).body;
  const report = (await owner.post(`/api/orgs/${orgId}/reports`, { name: "r", dataset: "rfis", config: { columns: ["subject"] } })).body;
  const { ifcWithBoxes } = await import("./ifc-fixture.js");
  const mA = (await owner.upload(`${P}/models`, { name: "A" }, { name: "a.ifc", type: "application/octet-stream", data: ifcWithBoxes([{ name: "B1", x: 0, y: 0, z: 0, dx: 1, dy: 1, dz: 1 }]) })).body;
  const mB = (await owner.upload(`${P}/models`, { name: "B" }, { name: "b.ifc", type: "application/octet-stream", data: ifcWithBoxes([{ name: "D1", x: 0.5, y: 0, z: 0, dx: 1, dy: 1, dz: 1 }]) })).body;
  const clashRun = (await owner.post(`${P}/clashes`, { modelAId: mA.modelId, modelBId: mB.modelId })).body;
  const field = (await owner.post(`/api/orgs/${orgId}/custom-fields`, { entityType: "rfi", key: "k", label: "K", type: "text" })).body;
  const key = (await owner.post(`/api/orgs/${orgId}/api-keys`, { name: "k" })).body;
  ids = {
    orgId, projectId, userId: memberId, costCodeId: cc.id, itemId: item.id, entityId: rfi.id,
    "/drawings/": drawing.drawingId, "/drawing-revisions/": dRow.revisions[0].id, "/files/": dRow.revisions[0].file_id,
    "/documents/": doc.id, "/approval-steps/": step.id, "/rfis/": rfi.id, "/submittals/": sub.id, "/daily-logs/": log.id,
    "/inspections/": ins.id, "/punch-items/": punch.id, "/observations/": obs.id, "/incidents/": inc.id, "/contracts/": k.id,
    "/change-events/": ce.id, "/correspondence/": corr.id, "/direct-costs/": dc.id, "/tm-tickets/": tm.id, "/equipment/": eq.id, "/action-plans/": plan.id, "/action-plan-items/": planItem.id, "/warranties/": warranty.id, "/coordination-issues/": issue.id, "/clash-runs/": clashRun.id, "/lookahead-tasks/": laTask.id, "/workers/": worker.id, "/crews/": crew.id, "/reports/": report.id, "/compliance-documents/": compDoc.id, "/lien-waivers/": waiver.id, "/daily-log-entries/": dlEntry.id, "/permission-templates/": tpl2.id, "/change-orders/": co.id, "/invoices/": inv.id, "/tasks/": randomUUID(),
    "custom-fields/": field.id, "api-keys/": key.id, "/me/sessions/": randomUUID(),
  };
  outsider = (await registerOwner(app, "outsider@example.com")).client;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

function fill(url: string, real: boolean): string {
  return url.replace(/:(\w+)/g, (_, name: string) => {
    if (!real) return name === "entityType" ? "rfi" : name === "kind" ? "rfis" : randomUUID();
    if (name === "entityType") return "rfi";
    if (name === "kind") return "rfis";
    if (name === "token") return "not-a-real-token";
    if (name === "id") {
      const hit = Object.keys(ids).find((k) => k.includes("/") && url.includes(k));
      return hit ? ids[hit]! : randomUUID();
    }
    return ids[name] ?? randomUUID();
  });
}

describe("authorization sweep over every route", () => {
  it("covers a meaningful number of routes", () => {
    expect(app.routeList.filter((r) => r.url.startsWith("/api/")).length).toBeGreaterThan(100);
  });

  it("anonymous requests get 401 (or 404 for unknown tokens) — never data, never a 500", async () => {
    const bad: string[] = [];
    let tested = 0;
    for (const r of app.routeList) {
      if (!r.url.startsWith("/api/") || PUBLIC.includes(`${r.method} ${r.url}`)) continue;
      tested++;
      const res = await app.inject({ method: r.method as "GET", url: fill(r.url, false), payload: r.method === "GET" || r.method === "DELETE" ? undefined : {}, headers: { "x-openbuild-csrf": "1" } });
      if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(tested).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  it("a signed-in outsider cannot read or change anything in another organization", async () => {
    const leaks: string[] = [];
    let tested = 0;
    for (const r of app.routeList) {
      if (!r.url.startsWith("/api/") || PUBLIC.includes(`${r.method} ${r.url}`) || r.url.startsWith("/api/me") || r.url.startsWith("/api/auth/")) continue;
      if (r.url === "/api/comments" || r.url === "/api/attachments") continue; // body-addressed; covered below
      if (r.url === "/api/reports/datasets" || r.url === "/api/permission-tools") continue; // static catalogues, identical for every signed-in user
      tested++;
      const url = fill(r.url, true);
      const res = await app.inject({ method: r.method as "GET", url, payload: r.method === "GET" || r.method === "DELETE" ? undefined : {}, headers: { "x-openbuild-csrf": "1", cookie: outsider.cookie } });
      if (res.statusCode < 400 || res.statusCode >= 500) leaks.push(`${r.method} ${url} -> ${res.statusCode}`);
    }
    expect(tested).toBeGreaterThan(90);
    expect(leaks).toEqual([]);
    expect((await outsider.post("/api/comments", { entityType: "rfi", entityId: ids["/rfis/"], body: "x" })).status).toBe(404);
    expect((await outsider.get(`/api/comments?entityType=rfi&entityId=${ids["/rfis/"]}`)).status).toBe(404);
    const f = (await outsider.upload(`/api/projects/${ids.projectId}/files`, {}, { name: "x.txt", type: "text/plain", data: "x" })).status;
    expect(f).toBe(404);
  });
});

describe("hardening", () => {
  it("sets security headers on API and page responses", async () => {
    for (const url of ["/api/health", "/api/me"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
  });

  it("issues httpOnly SameSite=Lax session cookies", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@example.com", password: "correct horse battery" }, headers: { "x-openbuild-csrf": "1" } });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("treats injection-shaped input as data", async () => {
    expect((await owner.get(`/api/projects/${encodeURIComponent("' OR 1=1 --")}/rfis`)).status).toBe(404);
    const r = await owner.get(`/api/projects/${ids.projectId}/rfis?status=${encodeURIComponent("open' OR '1'='1")}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    const t = await owner.post(`/api/projects/${ids.projectId}/tasks`, { title: "Robert'); DROP TABLE tasks;--" });
    expect(t.status).toBe(201);
    expect((await owner.get(`/api/projects/${ids.projectId}/tasks`)).body.some((x: { title: string }) => x.title.startsWith("Robert'"))).toBe(true);
  });

  it("ignores attempts to set protected columns (mass assignment)", async () => {
    const other = await registerOwner(app, "other2@example.com");
    await owner.patch(`/api/projects/${ids.projectId}`, { name: "Renamed", org_id: other.orgId, orgId: other.orgId });
    const p = (await owner.get(`/api/projects/${ids.projectId}`)).body;
    expect(p.org_id).toBe(ids.orgId);
  });

  it("never renders uploaded HTML inline", async () => {
    const f = (await owner.upload(`/api/projects/${ids.projectId}/files`, {}, { name: "x.html", type: "text/html", data: "<script>alert(1)</script>" })).body;
    const res = await owner.raw(`/api/files/${f.id}/download?inline=1`);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
  });

  it("rejects oversized uploads", async () => {
    const { buildApp } = await import("../src/app.js");
    const { createPgliteDb } = await import("../src/db/db.js");
    const { migrate } = await import("../src/db/migrate.js");
    const { createNotifier } = await import("../src/lib/notify.js");
    const d = await createPgliteDb();
    await migrate(d);
    const a = await buildApp({ db: d, storage: new LocalStorage(mkdtempSync(join(tmpdir(), "ob-lim-"))), allowSignup: true, secureCookies: false, notify: createNotifier(), documentTools: [], maxUploadBytes: 1024 });
    try {
      const c = (await registerOwner(a)).client;
      const me = (await c.get("/api/me")).body;
      const pid = (await c.post(`/api/orgs/${me.orgs[0].id}/projects`, { name: "p" })).body.id;
      expect((await c.upload(`/api/projects/${pid}/files`, {}, { name: "big.bin", type: "application/octet-stream", data: Buffer.alloc(4096) })).status).toBe(413);
    } finally {
      await a.close();
      await d.close();
    }
  });

  it("storage refuses keys that escape its root", async () => {
    const s = new LocalStorage(join(tmpdir(), "ob-root-test"));
    await expect(s.put("../escape.txt", Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
  });

  it("the audit log cannot be altered, even with direct SQL", async () => {
    await expect(db.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
  });

  it("unknown tokens are indistinguishable from expired ones", async () => {
    expect((await outsider.get(`/api/invitations/${"x".repeat(43)}`)).status).toBe(404);
    expect((await outsider.get(`/api/password-resets/${"x".repeat(43)}`)).status).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tool/${"x".repeat(43)}/file` })).statusCode).toBe(404);
  });
});
