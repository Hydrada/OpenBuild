import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;
let pm: { client: Client; userId: string };
let sub: { client: Client; userId: string };
let k: { id: string };
let other: { id: string };

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
  pm = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
  sub = await inviteAndJoin(app, owner, orgId, "acme@example.com", { projectId, projectRole: "subcontractor", company: "Acme Concrete" });
  await owner.post(`${P}/cost-codes`, { code: "03-300", description: "Concrete" });
  const cc = (await owner.get(`${P}/cost-codes`)).body[0].id;
  k = (await pm.client.post(`${P}/contracts`, { kind: "subcontract", title: "Concrete package", counterparty: "Acme Concrete", retainagePercent: "10", lines: [{ costCodeId: cc, description: "Foundations", amount: "100000" }] })).body;
  other = (await pm.client.post(`${P}/contracts`, { kind: "subcontract", title: "Steel", counterparty: "Iron Co", lines: [{ costCodeId: cc, description: "Steel", amount: "50000" }] })).body;
  for (const c of [k, other]) await owner.post(`/api/contracts/${c.id}/status`, { status: "approved" });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("subcontractor invoicing", () => {
  it("an invoice contact bills their own commitment and it routes to the project manager", async () => {
    expect((await sub.client.post(`/api/contracts/${k.id}/invoices`, { periodStart: "2026-10-01", periodEnd: "2026-10-31" })).status).toBe(404);
    expect((await pm.client.req("PUT", `/api/contracts/${k.id}/contacts`, { userIds: [sub.userId] })).status).toBe(200);
    const mine = (await sub.client.get(`${P}/my-contracts`)).body;
    expect(mine.map((c: { title: string; contractSum: string }) => [c.title, c.contractSum])).toEqual([["Concrete package", "100000.00"]]);

    const inv = (await sub.client.post(`/api/contracts/${k.id}/invoices`, { periodStart: "2026-10-01", periodEnd: "2026-10-31" })).body;
    const pa = (await sub.client.get(`/api/invoices/${inv.id}`)).body;
    expect(pa.isContact).toBe(true);
    await sub.client.req("PUT", `/api/invoices/${inv.id}/lines`, { lines: [{ key: pa.lines[0].key, workThisPeriod: "20000" }] });
    expect((await sub.client.post(`/api/invoices/${inv.id}/submit`, {})).status).toBe(200);
    const after = (await pm.client.get(`/api/invoices/${inv.id}`)).body;
    expect(after.invoice.status).toBe("submitted");
    expect(after.approvals[0]).toMatchObject({ approver_name: "pm", status: "pending" });
    expect(after.totals.current_payment_due).toBe("18000.00");
    expect((await pm.client.get("/api/me/notifications")).body.items[0].title).toContain("needs your approval");

    // Not their commitment, not their invoice, not editable once submitted.
    expect((await sub.client.post(`/api/contracts/${other.id}/invoices`, { periodStart: "2026-10-01", periodEnd: "2026-10-31" })).status).toBe(404);
    const steel = (await pm.client.post(`${P}/invoices`, { contractId: other.id, periodStart: "2026-10-01", periodEnd: "2026-10-31" })).body;
    expect((await sub.client.get(`/api/invoices/${steel.id}`)).status).toBe(404);
    expect((await sub.client.req("PUT", `/api/invoices/${inv.id}/lines`, { lines: [] })).status).toBe(409);
    expect((await sub.client.get(`${P}/invoices`)).status).toBe(403);
  });

  it("holds payment until insurance is current and the lien waiver is in", async () => {
    await pm.client.req("PUT", `/api/contracts/${k.id}/contacts`, { userIds: [sub.userId] });
    expect((await sub.client.req("PATCH", `/api/contracts/${k.id}/requirements`, { requireInsurance: true })).status).toBe(403);
    await pm.client.req("PATCH", `/api/contracts/${k.id}/requirements`, { requireInsurance: true, requireLienWaivers: true });
    const inv = (await sub.client.post(`/api/contracts/${k.id}/invoices`, { periodStart: "2026-10-01", periodEnd: "2026-10-31" })).body;
    const pa = (await sub.client.get(`/api/invoices/${inv.id}`)).body;
    await sub.client.req("PUT", `/api/invoices/${inv.id}/lines`, { lines: [{ key: pa.lines[0].key, workThisPeriod: "10000" }] });
    await sub.client.post(`/api/invoices/${inv.id}/submit`, {});
    const step = (await pm.client.get(`/api/invoices/${inv.id}`)).body.approvals[0];
    await pm.client.post(`/api/approval-steps/${step.id}/decide`, { decision: "approved" });

    let paid = await owner.post(`/api/invoices/${inv.id}/paid`, {});
    expect(paid.status).toBe(409);
    expect(paid.body.error).toBe("Payment is on hold: no accepted general liability certificate; no accepted workers' compensation certificate; lien waiver not received");

    // The subcontractor uploads certificates; only the project team can accept them.
    const gl = (await sub.client.post(`/api/contracts/${k.id}/compliance`, { kind: "general_liability", carrier: "Travelers", policyNumber: "GL-1", limitAmount: "2000000", effectiveOn: day(-300), expiresOn: day(65) })).body;
    const wc = (await sub.client.post(`/api/contracts/${k.id}/compliance`, { kind: "workers_comp", carrier: "Hartford", effectiveOn: day(-400), expiresOn: day(-2) })).body;
    const cert = (await sub.client.upload(`${P}/files`, {}, { name: "coi.pdf", type: "application/pdf", data: PDF("coi") })).body;
    expect((await sub.client.post("/api/attachments", { entityType: "compliance_document", entityId: gl.id, fileId: cert.id })).status).toBe(201);
    expect((await sub.client.req("PATCH", `/api/compliance-documents/${gl.id}`, { status: "accepted" })).status).toBe(403);
    for (const d of [gl, wc]) expect((await pm.client.req("PATCH", `/api/compliance-documents/${d.id}`, { status: "accepted" })).status).toBe(200);
    const docs = (await pm.client.get(`/api/contracts/${k.id}/compliance`)).body.documents;
    expect(docs.find((d: { kind: string }) => d.kind === "general_liability").files[0].name).toBe("coi.pdf");
    expect(docs.find((d: { kind: string }) => d.kind === "workers_comp").expired).toBe(true);

    paid = await owner.post(`/api/invoices/${inv.id}/paid`, {});
    expect(paid.body.error).toBe(`Payment is on hold: workers' compensation insurance expired ${day(-2)}; lien waiver not received`);

    const renewed = (await sub.client.post(`/api/contracts/${k.id}/compliance`, { kind: "workers_comp", carrier: "Hartford", effectiveOn: day(-1), expiresOn: day(364) })).body;
    await pm.client.req("PATCH", `/api/compliance-documents/${renewed.id}`, { status: "accepted" });
    const waiver = (await sub.client.post(`/api/invoices/${inv.id}/lien-waivers`, { kind: "conditional_progress" })).body;
    expect((await pm.client.get(`/api/invoices/${inv.id}`)).body.waivers[0]).toMatchObject({ kind: "conditional_progress", status: "received", amount: "9000.00" });
    expect((await pm.client.post(`/api/lien-waivers/${waiver.id}/status`, { status: "accepted" })).status).toBe(200);
    paid = await owner.post(`/api/invoices/${inv.id}/paid`, {});
    expect(paid.status).toBe(200);
  });
});
