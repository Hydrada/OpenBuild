import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportAll, importAll } from "../src/db/backup.js";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("schedule and milestones", () => {
  it("tracks activities, milestones, dependencies, lateness and the dashboard", async () => {
    const P = `/api/projects/${projectId}/schedule`;
    const found = (await owner.post(P, { name: "Foundations", startDate: "2020-01-06", endDate: "2020-02-14", percentComplete: 60 })).body;
    const steel = (await owner.post(P, { name: "Steel erection", startDate: "2020-02-10", endDate: "2020-04-01", predecessorId: found.id })).body;
    const topOut = (await owner.post(P, { name: "Top out", startDate: "2099-04-01", isMilestone: true, predecessorId: steel.id })).body;
    expect(topOut.end_date).toBe("2099-04-01");
    expect((await owner.post(P, { name: "bad", startDate: "2026-02-01", endDate: "2026-01-01" })).status).toBe(400);

    const list = (await owner.get(P)).body;
    const by = (n: string) => list.find((x: { name: string }) => x.name === n);
    expect(by("Foundations")).toMatchObject({ late: true, dependency_conflict: false });
    expect(by("Steel erection")).toMatchObject({ dependency_conflict: true, predecessor_name: "Foundations" });

    expect((await owner.patch(`/api/schedule/${found.id}`, { predecessorId: topOut.id })).status).toBe(400); // loop
    expect((await owner.patch(`/api/schedule/${found.id}`, { predecessorId: found.id })).status).toBe(400);
    expect((await owner.patch(`/api/schedule/${steel.id}`, { startDate: "2020-02-17" })).body.start_date).toBe("2020-02-17");
    expect((await owner.patch(`/api/schedule/${found.id}`, { percentComplete: 100 })).status).toBe(200);
    const after = (await owner.get(P)).body;
    expect(after.find((x: { name: string }) => x.name === "Foundations").late).toBe(false);
    expect(after.find((x: { name: string }) => x.name === "Steel erection").dependency_conflict).toBe(false);

    const near = (await owner.post(P, { name: "Owner walkthrough", startDate: "2020-03-01", isMilestone: true })).body;
    const dash = (await owner.get(`/api/orgs/${orgId}/dashboard`)).body;
    expect(dash.milestones.map((m: { name: string }) => m.name)).toEqual(["Owner walkthrough"]);
    expect(dash.milestones[0].late).toBe(true);
    expect((await owner.del(`/api/schedule/${near.id}`)).status).toBe(200);
  });

  it("enforces roles and survives backup/restore with dependencies", async () => {
    const { client: viewer } = await inviteAndJoin(app, owner, orgId, "v@example.com", { projectId, projectRole: "viewer" });
    const { client: sub } = await inviteAndJoin(app, owner, orgId, "s@example.com", { projectId, projectRole: "subcontractor" });
    const P = `/api/projects/${projectId}/schedule`;
    const a = (await owner.post(P, { name: "A", startDate: "2026-01-01" })).body;
    await owner.post(P, { name: "B", startDate: "2026-02-01", predecessorId: a.id });
    expect((await viewer.get(P)).status).toBe(200);
    expect((await viewer.post(P, { name: "x", startDate: "2026-01-01" })).status).toBe(403);
    expect((await sub.get(P)).status).toBe(403);

    const backup = JSON.parse(JSON.stringify(await exportAll(db)));
    backup.tables.schedule_items.reverse(); // dependent row first
    const target = await makeApp();
    try {
      await importAll(target.db, backup);
      const rows = await target.db.query<{ name: string; predecessor_id: string | null }>("SELECT name, predecessor_id FROM schedule_items ORDER BY name");
      expect(rows[1]!.predecessor_id).toBe(a.id);
    } finally {
      await target.app.close();
      await target.db.close();
    }
  });
});

describe("critical path", () => {
  it("computes early/late dates, float and the critical chain", async () => {
    const { criticalPath } = await import("../src/lib/cpm.js");
    // A (5 days) -> B (3 days); C (2 days) parallel, no dependency
    const r = criticalPath([
      { id: "A", start_date: "2026-01-01", end_date: "2026-01-05", predecessor_id: null },
      { id: "B", start_date: "2026-01-02", end_date: "2026-01-04", predecessor_id: "A" }, // planned too early; pushed to 01-06
      { id: "C", start_date: "2026-01-01", end_date: "2026-01-02", predecessor_id: null },
    ]);
    expect(r.get("B")).toMatchObject({ early_start: "2026-01-06", early_finish: "2026-01-08", total_float: 0, critical: true });
    expect(r.get("A")).toMatchObject({ late_finish: "2026-01-05", critical: true });
    expect(r.get("C")).toMatchObject({ late_finish: "2026-01-08", total_float: 6, critical: false });
  });

  it("is returned by the schedule API", async () => {
    const P = `/api/projects/${projectId}/schedule`;
    const a = (await owner.post(P, { name: "A", startDate: "2026-01-01", endDate: "2026-01-05" })).body;
    await owner.post(P, { name: "B", startDate: "2026-01-06", endDate: "2026-01-10", predecessorId: a.id });
    await owner.post(P, { name: "C", startDate: "2026-01-01", endDate: "2026-01-02" });
    const list = (await owner.get(P)).body;
    expect(list.filter((x: { critical: boolean }) => x.critical).map((x: { name: string }) => x.name)).toEqual(["A", "B"]);
    expect(list.find((x: { name: string }) => x.name === "C").total_float).toBe(8);
  });
});
