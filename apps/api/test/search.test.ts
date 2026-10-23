import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let sub: Client;
let P: string;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  const o = await registerOwner(app);
  owner = o.client;
  const projectId = (await owner.post(`/api/orgs/${o.orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
  const s = await inviteAndJoin(app, owner, o.orgId, "sub@example.com", { projectId, projectRole: "subcontractor" });
  sub = s.client;
  await owner.post(`${P}/rfis`, { subject: "Beam depth at grid C", question: "W18 or W21?", assigneeId: s.userId });
  await owner.post(`${P}/rfis`, { subject: "Beam pocket in shear wall", question: "Confirm embed plate" });
  await owner.post(`${P}/punch-items`, { title: "Touch up beam fireproofing" });
  await owner.upload(`${P}/drawings`, { number: "S-201", title: "Beam schedule", revision: "0" }, { name: "s.pdf", type: "application/pdf", data: PDF() });
  await owner.post(`${P}/change-events`, { title: "Beam upsizing" });
  await owner.post(`${P}/correspondence`, { kind: "notice", subject: "Beam delivery delay", private: true });
  await owner.post(`${P}/tasks`, { title: "100% literal" });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("project search", () => {
  it("finds records across tools", async () => {
    const r = (await owner.get(`${P}/search?q=beam`)).body.results;
    expect(r.map((x: { kindLabel: string }) => x.kindLabel).sort()).toEqual(["Change event", "Correspondence", "Drawing", "Punch item", "RFI", "RFI"]);
    expect(r.find((x: { kind: string }) => x.kind === "drawing")).toMatchObject({ ref: "S-201", title: "Beam schedule" });
    expect(r.every((x: { href: string }) => x.href.startsWith("/"))).toBe(true);
  });

  it("matches on numbers and question text, and puts exact references first", async () => {
    expect((await owner.get(`${P}/search?q=W21`)).body.results.map((x: { title: string }) => x.title)).toEqual(["Beam depth at grid C"]);
    expect((await owner.get(`${P}/search?q=S-201`)).body.results[0].ref).toBe("S-201");
  });

  it("only returns what a subcontractor may see", async () => {
    const r = (await sub.get(`${P}/search?q=beam`)).body.results;
    expect(r.map((x: { kind: string; title: string }) => `${x.kind}:${x.title}`).sort()).toEqual(["drawing:Beam schedule", "rfi:Beam depth at grid C"]);
  });

  it("treats wildcards literally and validates the query", async () => {
    expect((await owner.get(`${P}/search?q=100%25`)).body.results.map((x: { title: string }) => x.title)).toEqual(["100% literal"]);
    expect((await owner.get(`${P}/search?q=%25%25`)).body.results).toEqual([]);
    expect((await owner.get(`${P}/search?q=a`)).status).toBe(400);
  });
});
