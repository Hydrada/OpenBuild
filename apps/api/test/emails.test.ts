import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MailOptions } from "../src/lib/notify.js";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

const sent: { to: string; subject: string; text: string; options?: MailOptions }[] = [];
let failNext = false;
let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;

beforeAll(async () => {
  ({ app, db } = await makeApp({ mailer: async (to, subject, text, options) => {
    if (failNext) { failNext = false; throw new Error("SMTP 550 mailbox unavailable"); }
    sent.push({ to, subject, text, options });
  } }));
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("project email", () => {
  it("sends with attachments and a thread tag, then threads inbound replies", async () => {
    const pm = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
    const f = (await owner.upload(`${P}/files`, {}, { name: "door-schedule.pdf", type: "application/pdf", data: PDF("doors") })).body;
    const r = await owner.post(`${P}/emails`, { to: ["Architect@Example.com"], cc: ["owner-rep@example.com"], subject: "Door hardware question", body: "See attached schedule.", fileIds: [f.id] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ thread: 1, status: "sent" });
    const mail = sent.find((m) => m.subject.startsWith("Door hardware"))!;
    expect(mail).toMatchObject({ to: "architect@example.com", subject: "Door hardware question [#E-1]" });
    expect(mail.options?.cc).toEqual(["owner-rep@example.com"]);
    expect(mail.options?.replyTo).toBe("owner@example.com");
    expect(mail.options?.attachments?.[0]?.filename).toBe("door-schedule.pdf");
    expect(mail.text).toContain("Olive Owner via OpenBuild (Harbor Tower)");

    // Inbound: only with the project's secret URL; the subject tag joins the thread.
    const { path } = (await owner.post(`${P}/emails/inbound-token`, {})).body;
    expect((await app.inject({ method: "POST", url: "/api/inbound-email/wrong", payload: { from: "x@y.z", subject: "hi" } })).statusCode).toBe(404);
    const reply = await app.inject({ method: "POST", url: path, payload: { from: "architect@example.com", subject: "RE: Door hardware question [#E-1]", text: "Use lever sets per spec 08 71 00." } });
    expect(reply.statusCode).toBe(202);
    expect(reply.json().thread).toBe(1);
    const fresh = await app.inject({ method: "POST", url: path, payload: { from: "vendor@example.com", subject: "Price list", text: "Attached." } });
    expect(fresh.json().thread).toBe(2);

    const t = (await owner.get(`${P}/emails/1`)).body;
    expect(t.messages.map((m: { direction: string; from_address: string }) => [m.direction, m.from_address])).toEqual([["outbound", "owner@example.com"], ["inbound", "architect@example.com"]]);
    expect(t.messages[0].files[0].name).toBe("door-schedule.pdf");
    expect((await owner.get(`${P}/emails`)).body.map((x: { thread_number: number; messages: number }) => [x.thread_number, x.messages]).sort()).toEqual([[1, 2], [2, 1]]);
    expect((await pm.client.get("/api/me/notifications")).body.items.some((n: { title: string }) => n.title.startsWith("Email from architect@example.com"))).toBe(true);
    // Rotating the secret retires the old URL.
    await owner.post(`${P}/emails/inbound-token`, {});
    expect((await app.inject({ method: "POST", url: path, payload: { from: "a@b.c", subject: "x" } })).statusCode).toBe(404);
  });

  it("records failures, validates addresses, and keeps viewers and subcontractors out", async () => {
    failNext = true;
    const r = (await owner.post(`${P}/emails`, { to: ["a@example.com"], subject: "Will fail", body: "x" })).body;
    expect(r).toMatchObject({ status: "failed", error: "SMTP 550 mailbox unavailable" });
    expect((await owner.post(`${P}/emails`, { to: ["not-an-email"], subject: "x", body: "x" })).status).toBe(400);
    const viewer = await inviteAndJoin(app, owner, orgId, "v@example.com", { projectId, projectRole: "viewer" });
    expect((await viewer.client.post(`${P}/emails`, { to: ["a@example.com"], subject: "x", body: "x" })).status).toBe(403);
    const sub = await inviteAndJoin(app, owner, orgId, "s@example.com", { projectId, projectRole: "subcontractor" });
    expect((await sub.client.get(`${P}/emails`)).status).toBe(403);
    const other = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Other" })).body.id;
    const f = (await owner.upload(`/api/projects/${other}/files`, {}, { name: "x.pdf", type: "application/pdf", data: PDF() })).body;
    expect((await owner.post(`${P}/emails`, { to: ["a@example.com"], subject: "x", body: "x", fileIds: [f.id] })).status).toBe(400);
  });
});
