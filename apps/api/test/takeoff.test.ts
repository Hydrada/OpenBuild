import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;
let rev: string;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
  const up = (await owner.upload(`${P}/drawings`, { number: "A-101", title: "Plan", revision: "0" }, { name: "a.pdf", type: "application/pdf", data: PDF() })).body;
  rev = (await owner.get(`/api/drawings/${up.drawingId}`)).body.revisions[0].id;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("takeoff", () => {
  it("calibrates from a known distance and measures lengths, areas and counts", async () => {
    const T = `/api/drawing-revisions/${rev}/takeoff`;
    expect((await owner.post(T, { name: "Wall", kind: "length", points: [[0.1, 0.5], [0.6, 0.5]] })).body.error).toBe("Set the sheet's scale first");
    // A 36x24 sheet (aspect 1.5): half its width is 0.75 sheet-heights; call that 30 ft -> 40 ft per height, 60 ft per width.
    const s = (await owner.req("PUT", `${T}/scale`, { a: [0.1, 0.5], b: [0.6, 0.5], distance: 30, unit: "ft", aspect: 1.5 })).body;
    expect(s).toMatchObject({ units_per_x: 60, units_per_y: 40, unit: "ft" });
    const wall = (await owner.post(T, { name: "Partition wall", kind: "length", points: [[0.1, 0.5], [0.6, 0.5], [0.6, 0.75]] })).body;
    expect(wall).toMatchObject({ quantity: 40, unit: "ft" }); // 30 ft + 0.25 x 40 ft
    const room = (await owner.post(T, { name: "Lobby floor", kind: "area", points: [[0.1, 0.5], [0.6, 0.5], [0.6, 0.75], [0.1, 0.75]] })).body;
    expect(room).toMatchObject({ quantity: 300, unit: "sf" }); // 30 ft x 10 ft
    expect((await owner.post(T, { name: "Doors", kind: "count", points: [[0.2, 0.2], [0.3, 0.2], [0.4, 0.2]] })).body).toMatchObject({ quantity: 3, unit: "ea" });
    expect((await owner.post(T, { name: "Bad", kind: "area", points: [[0.1, 0.1], [0.2, 0.2]] })).status).toBe(400);

    // Recalibrating re-measures everything.
    await owner.req("PUT", `${T}/scale`, { a: [0.1, 0.5], b: [0.6, 0.5], distance: 60, unit: "ft", aspect: 1.5 });
    const items = (await owner.get(T)).body.items;
    expect(items.map((i: { name: string; quantity: string }) => [i.name, i.quantity])).toEqual([["Partition wall", "80.000"], ["Lobby floor", "1200.000"], ["Doors", "3.000"]]);
    expect((await owner.get(`${P}/takeoff`)).body.map((i: { sheet: string }) => i.sheet)).toEqual(["A-101", "A-101", "A-101"]);
    expect((await owner.req("PUT", `${T}/scale`, { a: [0.1, 0.5], b: [0.1, 0.5], distance: 10, unit: "ft", aspect: 1.5 })).status).toBe(400);
  });

  it("viewers read but cannot measure; other companies see nothing", async () => {
    const viewer = await inviteAndJoin(app, owner, orgId, "v@example.com", { projectId, projectRole: "viewer" });
    expect((await viewer.client.get(`/api/drawing-revisions/${rev}/takeoff`)).status).toBe(200);
    expect((await viewer.client.post(`/api/drawing-revisions/${rev}/takeoff`, { name: "x", kind: "count", points: [[0.1, 0.1]] })).status).toBe(403);
    const outsider = await registerOwner(app, "x@example.com");
    expect((await outsider.client.get(`/api/drawing-revisions/${rev}/takeoff`)).status).toBe(404);
  });
});
