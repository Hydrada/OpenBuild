import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exifTakenAt } from "../src/lib/exif.js";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

/** Minimal JPEG whose EXIF block holds DateTimeOriginal (little- or big-endian TIFF). */
function jpegWithExif(when: string, littleEndian = true) {
  const t = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4 + 20);
  const u16 = (o: number, v: number) => (littleEndian ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
  const u32 = (o: number, v: number) => (littleEndian ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o));
  t.write(littleEndian ? "II" : "MM", 0, "latin1"); u16(2, 42); u32(4, 8);
  u16(8, 1); u16(10, 0x8769); u16(12, 4); u32(14, 1); u32(18, 26); u32(22, 0); // IFD0 -> Exif IFD at 26
  u16(26, 1); u16(28, 0x9003); u16(30, 2); u32(32, 20); u32(36, 44); u32(40, 0); // DateTimeOriginal at 44
  t.write(`${when}\0`, 44, "latin1");
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]);
}

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("EXIF", () => {
  it("reads DateTimeOriginal in either byte order and ignores junk", () => {
    expect(exifTakenAt(jpegWithExif("2026:10:05 07:30:15"))).toBe("2026-10-05T07:30:15");
    expect(exifTakenAt(jpegWithExif("2025:01:31 23:59:59", false))).toBe("2025-01-31T23:59:59");
    expect(exifTakenAt(jpegWithExif("0000:00:00 00:00:00"))).toBeNull();
    expect(exifTakenAt(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]))).toBeNull();
    expect(exifTakenAt(Buffer.from("not a jpeg"))).toBeNull();
  });
});

describe("photo library", () => {
  it("albums, captions and tags, with capture time from EXIF", async () => {
    const pour = (await owner.upload(`${P}/files`, {}, { name: "pour.jpg", type: "image/jpeg", data: jpegWithExif("2026:10:05 07:30:15") })).body;
    const roof = (await owner.upload(`${P}/files`, {}, { name: "roof.jpg", type: "image/jpeg", data: jpegWithExif("2026:10:09 14:00:00") })).body;
    let photos = (await owner.get(`${P}/photos`)).body;
    expect(photos.map((p: { name: string; taken_at: string }) => [p.name, p.taken_at])).toEqual([["roof.jpg", "2026-10-09T14:00:00"], ["pour.jpg", "2026-10-05T07:30:15"]]);

    const album = (await owner.post(`${P}/photo-albums`, { name: "Level 3 pour" })).body;
    expect((await owner.post(`${P}/photo-albums`, { name: "level 3 POUR" })).status).toBe(409);
    expect((await owner.patch(`/api/photos/${pour.id}`, { albumId: album.id, caption: "Pump truck set up", location: "Grid C/4", tags: ["Concrete", "concrete", "L3"] })).status).toBe(200);
    photos = (await owner.get(`${P}/photos?album=${album.id}`)).body;
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ caption: "Pump truck set up", location: "Grid C/4", tags: ["concrete", "l3"], album_name: "Level 3 pour" });
    expect((await owner.get(`${P}/photos?tag=concrete`)).body.map((p: { name: string }) => p.name)).toEqual(["pour.jpg"]);
    expect((await owner.get(`${P}/photos?album=none`)).body.map((p: { name: string }) => p.name)).toEqual(["roof.jpg"]);
    expect((await owner.get(`${P}/photos?from=2026-10-06&to=2026-10-31`)).body.map((p: { name: string }) => p.name)).toEqual(["roof.jpg"]);
    // A later partial update keeps the rest.
    await owner.patch(`/api/photos/${pour.id}`, { caption: "Pump truck" });
    expect((await owner.get(`${P}/photos?album=${album.id}`)).body[0]).toMatchObject({ caption: "Pump truck", location: "Grid C/4", tags: ["concrete", "l3"] });
    expect((await owner.get(`${P}/photo-albums`)).body).toEqual([{ id: album.id, name: "Level 3 pour", photos: 1 }]);

    const viewer = await inviteAndJoin(app, owner, orgId, "v@example.com", { projectId, projectRole: "viewer" });
    expect((await viewer.client.patch(`/api/photos/${roof.id}`, { caption: "x" })).status).toBe(403);
    const other = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Other" })).body.id;
    const foreignAlbum = (await owner.post(`/api/projects/${other}/photo-albums`, { name: "Elsewhere" })).body;
    expect((await owner.patch(`/api/photos/${roof.id}`, { albumId: foreignAlbum.id })).status).toBe(400);
  });
});

describe("daily log sections", () => {
  it("records deliveries, calls, violations, quantities and waste, and pulls equipment and crew time for the day", async () => {
    await owner.post(`${P}/cost-codes`, { code: "03-300", description: "Concrete" });
    const cc = (await owner.get(`${P}/cost-codes`)).body[0].id;
    const log = (await owner.post(`${P}/daily-logs`, { logDate: "2026-10-05" })).body;
    const add = (b: object) => owner.post(`/api/daily-logs/${log.id}/entries`, b);
    expect((await add({ kind: "delivery", atTime: "07:15", party: "Ready Mix Co", description: "9 trucks, 90 CY 4000 psi" })).status).toBe(201);
    expect((await add({ kind: "call", atTime: "10:30", party: "Inspector", description: "Rebar inspection passed" })).status).toBe(201);
    expect((await add({ kind: "safety_violation", party: "Acme Concrete", description: "No hard hat at pump" })).status).toBe(201);
    expect((await add({ kind: "quantity", description: "Slab on deck L3", quantity: "88.5", unit: "CY", costCodeId: cc })).status).toBe(201);
    expect((await add({ kind: "quantity", description: "missing qty" })).status).toBe(400);
    expect((await add({ kind: "delivery", atTime: "7:15", description: "bad time" })).status).toBe(400);
    expect((await add({ kind: "waste", party: "Hauler", description: "1 x 30 yd dumpster", quantity: 1, unit: "ea" })).status).toBe(201);

    const eq = (await owner.post(`${P}/equipment`, { name: "Concrete pump" })).body;
    await owner.post(`/api/equipment/${eq.id}/logs`, { logDate: "2026-10-05", hoursOperated: 6, hoursIdle: 1 });
    await owner.post(`${P}/timesheets`, { workDate: "2026-10-05", hours: "9" });

    const s = (await owner.get(`/api/daily-logs/${log.id}/sections`)).body;
    expect(s.entries.map((e: { kind: string }) => e.kind)).toEqual(["call", "delivery", "quantity", "safety_violation", "waste"]);
    expect(s.entries.find((e: { kind: string }) => e.kind === "quantity")).toMatchObject({ quantity: "88.50", unit: "CY", cost_code: "03-300" });
    expect(s.equipment).toEqual([{ name: "Concrete pump", hours_operated: "6.00", hours_idle: "1.00" }]);
    expect(s.time).toEqual([{ worker: "Olive Owner", hours: "9.00", status: "submitted" }]);

    await owner.post(`/api/daily-logs/${log.id}/sign`, {});
    expect((await add({ kind: "call", description: "late" })).status).toBe(409);
    expect((await owner.req("DELETE", `/api/daily-log-entries/${s.entries[0].id}`)).status).toBe(409);
  });
});
