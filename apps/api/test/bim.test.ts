import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizeIfc } from "../src/lib/ifc.js";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;

/** Minimal valid-structure IFC (STEP physical file) with the given numbers of walls and doors. */
export function ifc(walls: number, doors: number, schema = "IFC4") {
  const lines = ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    "FILE_NAME('tower.ifc','2026-10-22T10:00:00',('OpenBuild test'),(''),'','','');", `FILE_SCHEMA(('${schema}'));`, "ENDSEC;", "DATA;",
    "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Harbor Tower',$,$,$,$,$,$);", "#2=IFCBUILDINGSTOREY('2',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);"];
  let id = 10;
  for (let i = 0; i < walls; i++) lines.push(`#${id++}=IFCWALLSTANDARDCASE('w${i}',$,'Wall ${i}',$,$,$,$,$,$);`);
  for (let i = 0; i < doors; i++) lines.push(`#${id++}= IFCDOOR('d${i}',$,'Door ${i}',$,$,$,$,$,2.1,0.9,$,$,$);`);
  lines.push("ENDSEC;", "END-ISO-10303-21;");
  return Buffer.from(lines.join("\n"));
}

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("BIM model register", () => {
  it("summarizes IFC files", () => {
    expect(summarizeIfc(ifc(3, 2, "IFC2X3"))).toEqual({ schema: "IFC2X3", counts: { Doors: 2, Storeys: 1, Walls: 3 } });
  });

  it("versions models and reports element changes", async () => {
    const P = `/api/projects/${projectId}/models`;
    expect((await owner.upload(P, { name: "Architecture" }, { name: "a.pdf", type: "application/pdf", data: "%PDF-1.4" })).status).toBe(400);
    const v1 = await owner.upload(P, { name: "Architecture", discipline: "Architectural" }, { name: "tower.ifc", type: "application/octet-stream", data: ifc(40, 12) });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, schema: "IFC4", counts: { Walls: 40, Doors: 12, Storeys: 1 } });
    const v2 = await owner.upload(P, { name: "Architecture", note: "Added stair core doors" }, { name: "tower-v2.ifc", type: "application/octet-stream", data: ifc(42, 15) });
    expect(v2.body.version).toBe(2);

    const list = (await owner.get(P)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Architecture", version: 2 });
    const detail = (await owner.get(`/api/models/${v2.body.modelId}`)).body;
    const changes = Object.fromEntries(detail.versions[0].changes.map((c: { type: string; change: number }) => [c.type, c.change]));
    expect(changes).toEqual({ Doors: 3, Storeys: 0, Walls: 2 });
    const file = await owner.raw(`/api/files/${detail.versions[1].file_id}/download`);
    expect(file.body).toContain("END-ISO-10303-21;");

    const { client: viewer } = await inviteAndJoin(app, owner, orgId, "v@example.com", { projectId, projectRole: "viewer" });
    expect((await viewer.get(P)).body).toHaveLength(1);
    expect((await viewer.upload(P, { name: "x" }, { name: "x.ifc", type: "application/octet-stream", data: ifc(1, 1) })).status).toBe(403);
  });
});

describe("clash detection", () => {
  it("finds real geometric clashes between two models and records the run", async () => {
    const { ifcWithBoxes } = await import("./ifc-fixture.js");
    const P = `/api/projects/${projectId}/models`;
    const arch = ifcWithBoxes([
      { name: "Beam B1", x: 0, y: 0, z: 3, dx: 6, dy: 0.3, dz: 0.5 },
      { type: "IFCWALL", name: "Wall W1", x: 10, y: 0, z: 0, dx: 0.2, dy: 5, dz: 3 },
    ]);
    const mep = ifcWithBoxes([
      { type: "IFCDUCTSEGMENT", name: "Duct D1", x: 2, y: -1, z: 3.1, dx: 0.4, dy: 3, dz: 0.3 }, // through the beam
      { type: "IFCPIPESEGMENT", name: "Pipe P1", x: 20, y: 0, z: 0, dx: 0.1, dy: 0.1, dz: 2 },   // clear
      { type: "IFCPIPESEGMENT", name: "Pipe P2", x: 10.205, y: 1, z: 1, dx: 0.1, dy: 0.1, dz: 0.5 }, // 5 mm clear of the wall
    ]);
    const a = (await owner.upload(P, { name: "Architecture" }, { name: "arch.ifc", type: "application/octet-stream", data: arch })).body;
    const b = (await owner.upload(P, { name: "MEP", discipline: "Mechanical" }, { name: "mep.ifc", type: "application/octet-stream", data: mep })).body;
    const run = await owner.post(`/api/projects/${projectId}/clashes`, { modelAId: a.modelId, modelBId: b.modelId, toleranceMm: 10 });
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ a: "Architecture v1", b: "MEP v1", clashCount: 1 });
    expect(run.body.clashes[0]).toMatchObject({ a: { name: "Beam B1", type: "IfcBuildingElementProxy" }, b: { name: "Duct D1", type: "IfcDuctSegment" } });
    expect(run.body.clashes[0].overlapM).toEqual([0.4, 0.3, 0.3]);
    expect((await owner.post(`/api/projects/${projectId}/clashes`, { modelAId: a.modelId, modelBId: a.modelId })).status).toBe(400);
    const history = (await owner.get(`/api/projects/${projectId}/clashes`)).body;
    expect(history[0]).toMatchObject({ model_a: "Architecture v1", model_b: "MEP v1", clash_count: 1, run_by: "Olive Owner" });
  });
});
