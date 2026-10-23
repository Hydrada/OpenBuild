import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("crews and foreman time", () => {
  it("a foreman enters crew hours; a manager approves; payroll lists the workers", async () => {
    const foreman = await inviteAndJoin(app, owner, orgId, "fred@example.com", { projectId, projectRole: "contributor" });
    const a = (await owner.post(`/api/orgs/${orgId}/workers`, { name: "Ana Laborer", employeeNumber: "E-100", trade: "Laborer" })).body;
    const b = (await owner.post(`/api/orgs/${orgId}/workers`, { name: "Bo Carpenter", employeeNumber: "E-101", trade: "Carpenter" })).body;
    expect((await owner.post(`/api/orgs/${orgId}/workers`, { name: "Dup", employeeNumber: "e-100" })).status).toBe(409);
    const outsiderWorker = (await (await registerOwner(app, "x@example.com")).client.post(`/api/orgs/${(await registerOwner(app, "y@example.com")).orgId}/workers`, { name: "Elsewhere" })).body;

    expect((await owner.post(`${P}/crews`, { name: "Concrete A", foremanId: foreman.userId, workerIds: [a.id, outsiderWorker.id] })).status).toBe(400);
    const crew = (await owner.post(`${P}/crews`, { name: "Concrete A", foremanId: foreman.userId, workerIds: [a.id, b.id] })).body;
    expect((await owner.post(`${P}/crews`, { name: "concrete a" })).status).toBe(409);
    expect((await owner.get(`${P}/crews`)).body[0].members.map((m: { name: string }) => m.name)).toEqual(["Ana Laborer", "Bo Carpenter"]);

    const entry = { crewId: crew.id, workDate: "2026-10-05", description: "Formed L3 deck", entries: [{ workerId: a.id, hours: "10" }, { workerId: b.id, hours: 8.5 }] };
    expect((await foreman.client.post(`${P}/timesheets/crew`, entry)).body).toEqual({ created: 2 });
    expect((await foreman.client.post(`${P}/timesheets/crew`, { ...entry, entries: [{ workerId: a.id, hours: "15" }] })).status).toBe(400); // 25 h
    const c = await inviteAndJoin(app, owner, orgId, "c@example.com", { projectId, projectRole: "contributor" });
    expect((await c.client.post(`${P}/timesheets/crew`, { ...entry, workDate: "2026-10-06" })).status).toBe(403); // not the foreman

    // The foreman sees what they entered; the manager approves; the foreman cannot approve their own entries.
    const mine = (await foreman.client.get(`${P}/timesheets`)).body.entries;
    expect(mine.map((e: { worker_name: string; entered_by_name: string }) => [e.worker_name, e.entered_by_name])).toEqual([["Ana Laborer", "fred"], ["Bo Carpenter", "fred"]]);
    const pm = await inviteAndJoin(app, owner, orgId, "pm@example.com", { projectId, projectRole: "manager" });
    const fromPm = await pm.client.post(`${P}/timesheets/crew`, { ...entry, workDate: "2026-10-06" });
    expect(fromPm.status).toBe(201);
    const pmEntries = (await owner.get(`${P}/timesheets?from=2026-10-06&to=2026-10-06`)).body.entries;
    expect((await pm.client.post(`/api/timesheets/${pmEntries[0].id}/decide`, { decision: "approved" })).status).toBe(403);
    for (const e of mine) expect((await owner.post(`/api/timesheets/${e.id}/decide`, { decision: "approved" })).status).toBe(200);

    const pay = (await owner.get(`${P}/timesheets/payroll?from=2026-10-01&to=2026-10-31`)).body.rows;
    expect(pay.map((r: { worker: string; email: string; hours: string }) => [r.worker, r.email, r.hours])).toEqual([["Ana Laborer", "E-100", "10.00"], ["Bo Carpenter", "E-101", "8.50"]]);
  });

  it("only org admins manage the worker directory; managers can add on site", async () => {
    const member = await inviteAndJoin(app, owner, orgId, "m@example.com", { projectId, projectRole: "manager" });
    expect((await member.client.post(`/api/orgs/${orgId}/workers`, { name: "x" })).status).toBe(403);
    const w = (await member.client.post(`${P}/workers`, { name: "New hire" })).body;
    expect((await member.client.get(`/api/orgs/${orgId}/workers`)).body.map((x: { name: string }) => x.name)).toEqual(["New hire"]);
    expect((await member.client.patch(`/api/workers/${w.id}`, { active: false })).status).toBe(403);
    expect((await owner.patch(`/api/workers/${w.id}`, { active: false })).status).toBe(200);
    expect((await owner.get(`/api/orgs/${orgId}/workers`)).body[0]).toMatchObject({ name: "New hire", active: false });
    const outsider = await registerOwner(app, "z@example.com");
    expect((await outsider.client.patch(`/api/workers/${w.id}`, { name: "hijack" })).status).toBe(404);
  });
});
