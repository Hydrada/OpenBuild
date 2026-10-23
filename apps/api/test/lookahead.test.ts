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

describe("three-week lookahead", () => {
  it("shows the window's working days, overlapping activities with float, and lookahead tasks", async () => {
    await owner.req("PUT", `${P}/calendar`, { workDays: [1, 2, 3, 4, 5], holidays: [{ day: "2026-10-12", name: "Columbus Day" }] });
    const pour = (await owner.post(`${P}/schedule`, { name: "Pour level 3", startDate: "2026-10-07", endDate: "2026-10-16" })).body;
    await owner.post(`${P}/schedule`, { name: "Curtain wall", startDate: "2026-12-01", endDate: "2026-12-20" });
    await owner.post(`${P}/schedule`, { name: "Rebar L2", startDate: "2026-09-01", endDate: "2026-10-02" });
    const foreman = await inviteAndJoin(app, owner, orgId, "f@example.com", { projectId, projectRole: "contributor" });

    const t = await foreman.client.post(`${P}/lookahead-tasks`, { name: "Form deck bay 3", startDate: "2026-10-08", endDate: "2026-10-09", scheduleItemId: pour.id, company: "Acme Concrete", crewSize: 6 });
    expect(t.status).toBe(201);
    expect((await foreman.client.post(`${P}/lookahead-tasks`, { name: "x", startDate: "2026-10-09", endDate: "2026-10-08" })).status).toBe(400);
    expect((await foreman.client.post(`${P}/lookahead-tasks`, { name: "x", startDate: "2026-10-09", endDate: "2026-10-09", status: "blocked" })).status).toBe(400);

    const la = (await owner.get(`${P}/lookahead?from=2026-10-05&weeks=3`)).body;
    expect(la).toMatchObject({ from: "2026-10-05", to: "2026-10-25" });
    expect(la.days).toHaveLength(21);
    expect(la.days.filter((d: { working: boolean }) => d.working)).toHaveLength(14); // 15 weekdays minus the holiday
    expect(la.days.find((d: { date: string }) => d.date === "2026-10-12").working).toBe(false);
    expect(la.activities.map((a: { name: string }) => a.name)).toEqual(["Pour level 3"]);
    expect(la.activities[0].critical).toBe(false); // curtain wall finishes later, so the pour has float
    expect(la.tasks[0]).toMatchObject({ name: "Form deck bay 3", schedule_item_id: pour.id, crew_size: 6, status: "planned" });

    // Blocking a task needs a reason; a later partial update keeps it.
    expect((await foreman.client.patch(`/api/lookahead-tasks/${t.body.id}`, { status: "blocked" })).status).toBe(400);
    expect((await foreman.client.patch(`/api/lookahead-tasks/${t.body.id}`, { status: "blocked", constraintNote: "Deck delivery late" })).status).toBe(200);
    expect((await foreman.client.patch(`/api/lookahead-tasks/${t.body.id}`, { crewSize: 8 })).status).toBe(200);
    const after = (await owner.get(`${P}/lookahead?from=2026-10-05`)).body.tasks[0];
    expect(after).toMatchObject({ status: "blocked", constraint_note: "Deck delivery late", crew_size: 8 });

    const viewer = await inviteAndJoin(app, owner, orgId, "v@example.com", { projectId, projectRole: "viewer" });
    expect((await viewer.client.post(`${P}/lookahead-tasks`, { name: "x", startDate: "2026-10-09", endDate: "2026-10-09" })).status).toBe(403);
    expect((await viewer.client.req("DELETE", `/api/lookahead-tasks/${t.body.id}`)).status).toBe(403);
    expect((await owner.req("DELETE", `/api/lookahead-tasks/${t.body.id}`)).status).toBe(200);
  });
});
