import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { criticalPath, levelResources } from "../src/lib/cpm.js";
import { parseMsProjectXml } from "../src/lib/msproject.js";
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

describe("link types", () => {
  const A = { id: "A", start_date: "2026-03-02", end_date: "2026-03-11" }; // 10 days
  const B = { id: "B", start_date: "2026-03-01", end_date: "2026-03-05" }; // 5 days, planned too early
  const run = (type: "FS" | "SS" | "FF" | "SF", lag = 0) => criticalPath([A, B], [{ successor_id: "B", predecessor_id: "A", lag_days: lag, link_type: type }]).get("B")!;

  it("computes early dates for each link type", () => {
    expect(run("FS")).toMatchObject({ early_start: "2026-03-12", early_finish: "2026-03-16" });
    expect(run("SS", 2)).toMatchObject({ early_start: "2026-03-04", early_finish: "2026-03-08" });
    expect(run("FF")).toMatchObject({ early_start: "2026-03-07", early_finish: "2026-03-11" });
    expect(run("SF", 3)).toMatchObject({ early_start: "2026-03-01", early_finish: "2026-03-05" }); // A.start+3 = 03-05 ≤ planned finish
  });

  it("keeps the driving predecessor critical through SS and FF links", () => {
    const r = criticalPath([A, { ...B, id: "C", start_date: "2026-03-02", end_date: "2026-03-11" }], [{ successor_id: "C", predecessor_id: "A", lag_days: 0, link_type: "FF" }]);
    expect(r.get("A")!.critical).toBe(true);
    expect(r.get("C")!.critical).toBe(true);
  });

  it("imports MS Project link types and reports them through the API", async () => {
    const xml = `<Project><Tasks>
      <Task><UID>1</UID><Name>Framing</Name><Start>2026-03-02T08:00:00</Start><Finish>2026-03-20T17:00:00</Finish></Task>
      <Task><UID>2</UID><Name>Inspections</Name><Start>2026-03-05T08:00:00</Start><Finish>2026-03-25T17:00:00</Finish>
        <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>3</Type><LinkLag>14400</LinkLag></PredecessorLink></Task>
    </Tasks></Project>`;
    expect(parseMsProjectXml(xml)[1]!.predecessors[0]).toEqual({ uid: "1", lagDays: 3, type: "SS" });
    await owner.post(`/api/projects/${projectId}/schedule/import`, { xml });
    const list = (await owner.get(`/api/projects/${projectId}/schedule`)).body;
    expect(list.find((x: { name: string }) => x.name === "Inspections").predecessors[0]).toMatchObject({ name: "Framing", type: "SS", lagDays: 3 });
  });
});

describe("working calendar", () => {
  it("skips weekends and holidays in early dates and float", () => {
    const cal = { workDays: [1, 2, 3, 4, 5], holidays: ["2026-07-03"] };
    // Fri 2026-06-26 → 5 working days ends Thu 07-02; successor FS starts Mon 07-06 (Fri 07-03 holiday, weekend skipped).
    const r = criticalPath([
      { id: "A", start_date: "2026-06-26", end_date: "2026-07-02" },
      { id: "B", start_date: "2026-06-29", end_date: "2026-06-30" },
    ], [{ successor_id: "B", predecessor_id: "A", lag_days: 0, link_type: "FS" }], cal);
    expect(r.get("B")).toMatchObject({ early_start: "2026-07-06", early_finish: "2026-07-07" });
    // A planned start on Saturday snaps to Monday.
    const s = criticalPath([{ id: "S", start_date: "2026-07-11", end_date: "2026-07-13" }], [], cal).get("S")!;
    expect(s.early_start).toBe("2026-07-13");
  });

  it("is configured per project and drives the schedule API", async () => {
    const P = `/api/projects/${projectId}`;
    expect((await owner.put(`${P}/calendar`, { workDays: [] })).status).toBe(400);
    expect((await owner.put(`${P}/calendar`, { workDays: [1, 2, 3, 4, 5], holidays: [{ day: "2026-07-03", name: "Independence Day (observed)" }] })).status).toBe(200);
    expect((await owner.get(`${P}/calendar`)).body).toEqual({ workDays: [1, 2, 3, 4, 5], holidays: [{ day: "2026-07-03", name: "Independence Day (observed)" }] });
    const a = (await owner.post(`${P}/schedule`, { name: "Framing", startDate: "2026-06-26", endDate: "2026-07-02" })).body;
    await owner.post(`${P}/schedule`, { name: "Sheathing", startDate: "2026-06-29", endDate: "2026-06-30", predecessors: [{ id: a.id }] });
    const sheathing = (await owner.get(`${P}/schedule`)).body.find((x: { name: string }) => x.name === "Sheathing");
    expect(sheathing.early_start).toBe("2026-07-06");
  });
});

describe("resource levelling", () => {
  it("delays the activity with more float so a crew is never over-allocated", () => {
    // Crew of 1. A (5 days) drives D; B (3 days) has float. Both planned on the same days.
    const items = [
      { id: "A", start_date: "2026-03-02", end_date: "2026-03-06", resource_id: "crew", resource_units: 1 },
      { id: "B", start_date: "2026-03-02", end_date: "2026-03-04", resource_id: "crew", resource_units: 1 },
      { id: "D", start_date: "2026-03-09", end_date: "2026-03-20", resource_id: null, resource_units: 1 },
    ];
    const links = [{ successor_id: "D", predecessor_id: "A", lag_days: 0, link_type: "FS" as const }];
    const { result, finishBefore, finishAfter } = levelResources(items, links, new Map([["crew", 1]]));
    expect(result.get("A")).toMatchObject({ start_date: "2026-03-02", delay_days: 0 });
    expect(result.get("B")).toMatchObject({ start_date: "2026-03-07", end_date: "2026-03-09", delay_days: 5 });
    expect([finishBefore, finishAfter]).toEqual(["2026-03-20", "2026-03-20"]); // B absorbed its float
    // With capacity 2 nothing moves
    expect(levelResources(items, links, new Map([["crew", 2]])).result.get("B")!.delay_days).toBe(0);
    expect(() => levelResources([{ ...items[0]!, resource_units: 3 }], [], new Map([["crew", 2]]))).toThrow(/more units/);
  });

  it("previews and applies levelling through the API", async () => {
    const P = `/api/projects/${projectId}`;
    const crew = (await owner.post(`${P}/resources`, { name: "Concrete crew", capacity: 1 })).body;
    expect((await owner.post(`${P}/resources`, { name: "concrete crew", capacity: 2 })).status).toBe(409);
    await owner.post(`${P}/schedule`, { name: "Footings", startDate: "2026-03-02", endDate: "2026-03-06", resourceId: crew.id });
    await owner.post(`${P}/schedule`, { name: "Slab on grade", startDate: "2026-03-03", endDate: "2026-03-05", resourceId: crew.id });
    const preview = (await owner.get(`${P}/schedule/level`)).body;
    expect(preview.changes.map((c: { name: string; start_date: string }) => [c.name, c.start_date])).toEqual([["Slab on grade", "2026-03-07"]]);
    expect((await owner.post(`${P}/schedule/level`)).body.moved).toBe(1);
    const slab = (await owner.get(`${P}/schedule`)).body.find((x: { name: string }) => x.name === "Slab on grade");
    expect(slab).toMatchObject({ start_date: "2026-03-07", end_date: "2026-03-09", resource_name: "Concrete crew" });
    expect((await owner.get(`${P}/schedule/level`)).body.changes).toEqual([]);
  });
});

describe("bidder prequalification", () => {
  it("only approved companies with current insurance can be invited from the directory", async () => {
    const D = `/api/orgs/${orgId}/bidder-companies`;
    const c = (await owner.post(D, { name: "Alpha Painting", trade: "Painting", email: "est@alpha.test", bondingLimit: "2,000,000", emr: "0.82" })).body;
    expect((await owner.post(D, { name: "alpha painting", email: "x@x.test" })).status).toBe(409);
    expect((await owner.post(`${D}/${c.id}/prequal`, { status: "approved" })).status).toBe(400); // no insurance on file
    await db.query("UPDATE bidder_companies SET insurance_expires = current_date + 180 WHERE id = $1", [c.id]);

    const pkg = (await owner.post(`/api/projects/${projectId}/bid-packages`, { title: "Painting", dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString() })).body;
    const pending = await owner.post(`/api/bid-packages/${pkg.id}/bidders`, { companyId: c.id });
    expect(pending.status).toBe(400);
    expect(pending.body.error).toMatch(/not prequalified \(pending\)/);
    expect((await owner.post(`${D}/${c.id}/prequal`, { status: "approved", notes: "Financials reviewed" })).status).toBe(200);
    expect((await owner.post(`/api/bid-packages/${pkg.id}/bidders`, { companyId: c.id })).status).toBe(201);
    const lev = (await owner.get(`/api/bid-packages/${pkg.id}`)).body;
    expect(lev.bidders[0]).toMatchObject({ company: "Alpha Painting", email: "est@alpha.test", prequal_status: "approved" });
    expect((await owner.get(`${D}?trade=paint`)).body[0]).toMatchObject({ prequal_status: "approved", bonding_limit: "2000000.00", emr: "0.82", reviewed_by_name: "Olive Owner" });

    const { client: member } = await inviteAndJoin(app, owner, orgId, "m@example.com");
    expect((await member.get(D)).status).toBe(200);
    expect((await member.post(`${D}/${c.id}/prequal`, { status: "rejected" })).status).toBe(403);
    const other = await registerOwner(app, "other@example.com");
    expect((await other.client.post(`/api/bid-packages/${pkg.id}/bidders`, { companyId: c.id })).status).toBe(404);
  });
});
