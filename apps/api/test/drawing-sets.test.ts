import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectSheets } from "../src/lib/sheets.js";
import { Client, PDF, makeApp, registerOwner, type App, type Db } from "./helpers.js";

/** A 24x36-ish set: notes that mention other sheets in small text, and a title block with labels, title and number. */
async function drawingSet(sheets: ({ number: string; title: string } | null)[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const s of sheets) {
    const page = doc.addPage([2592, 1728]);
    if (!s) continue; // a scanned sheet: no text layer
    page.drawText("GENERAL NOTES", { x: 80, y: 1600, size: 18, font: bold });
    page.drawText("1. SEE S-201 FOR FRAMING. 2. COORDINATE WITH M-101.", { x: 80, y: 1570, size: 12, font });
    page.drawText("SHEET TITLE", { x: 2080, y: 260, size: 9, font });
    page.drawText(s.title, { x: 2080, y: 230, size: 20, font: bold });
    page.drawText("SCALE: 1/8\" = 1'-0\"", { x: 2080, y: 190, size: 9, font });
    page.drawText("SHEET", { x: 2380, y: 140, size: 9, font });
    page.drawText(s.number, { x: 2380, y: 90, size: 40, font: bold });
  }
  return Buffer.from(await doc.save());
}

let app: App;
let db: Db;
let owner: Client;
let P: string;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  const o = await registerOwner(app);
  owner = o.client;
  const projectId = (await owner.post(`/api/orgs/${o.orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("drawing sets", () => {
  it("reads sheet numbers and titles from each title block", async () => {
    const pages = await detectSheets(await drawingSet([{ number: "A-101", title: "FIRST FLOOR PLAN" }, { number: "S-201", title: "SECOND FLOOR FRAMING" }, null, { number: "M-1.01", title: "HVAC PLAN" }]));
    expect(pages).toEqual([
      { page: 1, number: "A-101", title: "FIRST FLOOR PLAN", discipline: "Architectural" },
      { page: 2, number: "S-201", title: "SECOND FLOOR FRAMING", discipline: "Structural" },
      { page: 3, number: null, title: null, discipline: "General" },
      { page: 4, number: "M-1.01", title: "HVAC PLAN", discipline: "Mechanical" },
    ]);
  });

  it("splits a set into sheets, revising existing ones", async () => {
    await owner.upload(`${P}/drawings`, { number: "A-101", title: "First floor plan", revision: "0" }, { name: "a.pdf", type: "application/pdf", data: PDF() });
    const set = await drawingSet([{ number: "A-101", title: "FIRST FLOOR PLAN" }, { number: "S-201", title: "SECOND FLOOR FRAMING" }, null]);
    const an = await owner.upload(`${P}/drawing-sets/analyze`, {}, { name: "IFC-set.pdf", type: "application/pdf", data: set });
    expect(an.status).toBe(201);
    expect(an.body.pages[0].existing).toMatchObject({ number: "A-101", latest: "0" });
    expect(an.body.pages[1].existing).toBeNull();

    const sheets = an.body.pages.map((p: { page: number; number: string | null; title: string | null }) => ({ page: p.page, number: p.number ?? "G-001", title: p.title ?? "COVER" }));
    expect((await owner.post(`${P}/drawing-sets/import`, { fileId: an.body.fileId, revision: "1", sheets: [...sheets, { ...sheets[0], page: 2 }] })).status).toBe(400); // duplicate number
    const imp = await owner.post(`${P}/drawing-sets/import`, { fileId: an.body.fileId, revision: "1", setName: "Issued for construction", issuedDate: "2026-10-20", sheets });
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({ imported: 3, newSheets: 2 });
    const list = (await owner.get(`${P}/drawings`)).body;
    expect(list.map((d: { number: string }) => d.number).sort()).toEqual(["A-101", "G-001", "S-201"]);
    const a101 = (await owner.get(`/api/drawings/${imp.body.sheets[0].drawingId}`)).body;
    expect(a101.revisions.map((r: { revision: string; set_name: string | null }) => [r.revision, r.set_name])).toEqual([["1", "Issued for construction"], ["0", null]]);
    // Each sheet is its own one-page PDF.
    const file = await owner.raw(`/api/files/${a101.revisions[0].file_id}/download`);
    expect((await PDFDocument.load(file.rawPayload)).getPageCount()).toBe(1);
    // Importing the same revision again is refused, and nothing half-imports.
    expect((await owner.post(`${P}/drawing-sets/import`, { fileId: an.body.fileId, revision: "1", sheets })).status).toBe(409);
    expect((await owner.get(`${P}/drawings`)).body).toHaveLength(3);
  });

  it("rejects non-PDFs and pages that do not exist", async () => {
    expect((await owner.upload(`${P}/drawing-sets/analyze`, {}, { name: "x.txt", type: "text/plain", data: "hello" })).status).toBe(400);
    const an = (await owner.upload(`${P}/drawing-sets/analyze`, {}, { name: "s.pdf", type: "application/pdf", data: await drawingSet([{ number: "E-101", title: "POWER PLAN" }]) })).body;
    expect((await owner.post(`${P}/drawing-sets/import`, { fileId: an.fileId, revision: "0", sheets: [{ page: 2, number: "E-102", title: "X" }] })).status).toBe(400);
  });
});
