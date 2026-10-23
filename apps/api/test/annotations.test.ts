import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let rev: string;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  const up = (await owner.upload(`/api/projects/${projectId}/drawings`, { number: "A-101", title: "Plan", revision: "0" }, { name: "a.pdf", type: "application/pdf", data: PDF() })).body;
  rev = (await owner.get(`/api/drawings/${up.drawingId}`)).body.revisions[0].id;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const cloud = { type: "cloud", x: 0.1, y: 0.2, w: 0.3, h: 0.1, color: "red", label: "Check door swing" };

describe("drawing markups", () => {
  it("keeps personal layers private until published", async () => {
    const sub = await inviteAndJoin(app, owner, orgId, "sub@example.com", { projectId, projectRole: "subcontractor" });
    expect((await owner.req("PUT", `/api/drawing-revisions/${rev}/annotations`, { shapes: [cloud, { type: "arrow", x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.4, color: "blue" }] })).body).toMatchObject({ count: 2, published: false });
    // Subcontractors can see sheets and keep their own private markups, but cannot publish.
    expect((await sub.client.req("PUT", `/api/drawing-revisions/${rev}/annotations`, { shapes: [{ type: "text", x: 0.2, y: 0.2, text: "Sleeve here?", color: "green" }] })).status).toBe(200);
    expect((await sub.client.post(`/api/drawing-revisions/${rev}/annotations/publish`, { published: true })).status).toBe(403);
    let seen = (await sub.client.get(`/api/drawing-revisions/${rev}/annotations`)).body;
    expect(seen.published).toEqual([]);
    expect(seen.mine.shapes[0].text).toBe("Sleeve here?");
    expect(seen.canPublish).toBe(false);

    expect((await owner.post(`/api/drawing-revisions/${rev}/annotations/publish`, { published: true })).status).toBe(200);
    seen = (await sub.client.get(`/api/drawing-revisions/${rev}/annotations`)).body;
    expect(seen.published).toHaveLength(1);
    expect(seen.published[0]).toMatchObject({ author_name: "Olive Owner" });
    expect(seen.published[0].shapes[0]).toMatchObject(cloud);
    // The owner never sees the sub's private layer.
    expect((await owner.get(`/api/drawing-revisions/${rev}/annotations`)).body.published).toEqual([]);

    expect((await owner.post(`/api/drawing-revisions/${rev}/annotations/publish`, { published: false })).status).toBe(200);
    expect((await sub.client.get(`/api/drawing-revisions/${rev}/annotations`)).body.published).toEqual([]);
  });

  it("validates shapes and hides other companies' sheets", async () => {
    expect((await owner.req("PUT", `/api/drawing-revisions/${rev}/annotations`, { shapes: [{ ...cloud, x: 1.5 }] })).status).toBe(400);
    expect((await owner.req("PUT", `/api/drawing-revisions/${rev}/annotations`, { shapes: [{ type: "script", src: "x" }] })).status).toBe(400);
    expect((await owner.req("PUT", `/api/drawing-revisions/${rev}/annotations`, { shapes: Array.from({ length: 501 }, () => cloud) })).status).toBe(400);
    const outsider = await registerOwner(app, "x@example.com");
    expect((await outsider.client.get(`/api/drawing-revisions/${rev}/annotations`)).status).toBe(404);
    expect((await outsider.client.req("PUT", `/api/drawing-revisions/${rev}/annotations`, { shapes: [] })).status).toBe(404);
  });
});
