import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { member, world } from "./helpers";

/** A real one-page sheet: title block plus a "wall" whose position changes between revisions. */
async function sheet(rev: string, wallX: number, extraNote?: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([792, 612]);
  page.drawRectangle({ x: 20, y: 20, width: 752, height: 572, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  page.drawRectangle({ x: wallX, y: 200, width: 220, height: 14, color: rgb(0, 0, 0) });
  page.drawText(`A-101 FLOOR PLAN  REV ${rev}`, { x: 560, y: 40, size: 12, font });
  if (extraNote) page.drawText(extraNote, { x: 80, y: 500, size: 18, font });
  return { name: `A-101-r${rev}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}

test("sheet viewer: renders the sheet, saves and publishes a markup, compares revisions", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  for (const [rev, x, note] of [["0", 100, undefined], ["1", 300, "DOOR D-12 ADDED"]] as const) {
    const r = await owner.request.post(`/api/projects/${w.projectId}/drawings`, { headers: { "x-openbuild-csrf": "1" }, multipart: { number: "A-101", title: "Floor plan", revision: rev, file: await sheet(rev, x, note) } });
    expect(r.ok()).toBe(true);
  }
  const drawingId = (await (await owner.request.get(`/api/projects/${w.projectId}/drawings`)).json())[0].id;
  await owner.goto(`/drawings/${drawingId}`);
  const viewer = owner.getByRole("region", { name: "Sheet viewer" });
  await expect(viewer.getByRole("img", { name: "Sheet A-101 revision 1" })).toBeVisible({ timeout: 20_000 });

  // Draw a cloud by dragging on the markup layer, save, and check it survives a reload.
  await viewer.getByRole("button", { name: "Cloud", exact: true }).click();
  const layer = viewer.getByRole("application", { name: "Markup layer" });
  const box = (await layer.boundingBox())!;
  await owner.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await owner.mouse.down();
  await owner.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45, { steps: 5 });
  await owner.mouse.up();
  await viewer.getByRole("button", { name: "Text", exact: true }).click();
  await owner.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.3);
  await viewer.getByLabel("Markup text").fill("Verify door swing");
  await viewer.getByLabel("Markup text").press("Enter");
  await viewer.getByRole("button", { name: "Save markups" }).click();
  await expect(viewer.getByText("Saved 2 markup(s)")).toBeVisible();
  await viewer.getByRole("button", { name: "Publish to project" }).click();
  await expect(viewer.getByText("Published to the project")).toBeVisible();

  const arch = await member(browser, w, "Ari Architect", "viewer");
  await arch.page.goto(`/drawings/${drawingId}`);
  const av = arch.page.getByRole("region", { name: "Sheet viewer" });
  await expect(av.getByRole("group", { name: "Published markup layers" })).toContainText("Olive Owner (2)");
  await expect(av.getByRole("application", { name: "Markup layer" }).locator("path")).toHaveCount(1);
  await expect(av.getByRole("application", { name: "Markup layer" })).toContainText("Verify door swing");
  await expect(av.getByRole("button", { name: "Publish to project" })).toHaveCount(0);

  // Compare with revision 0: the moved wall and the new note show up as changes.
  await viewer.getByLabel("Compare with").selectOption({ label: "Rev 0" });
  await expect(viewer.getByRole("img", { name: "Sheet A-101 revision 1 compared with an earlier revision" })).toBeVisible({ timeout: 20_000 });
  await expect(viewer.getByText(/changed pixels/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("drawing set: upload one PDF, review detected sheets, publish them", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const [n, t] of [["A-101", "FIRST FLOOR PLAN"], ["A-102", "SECOND FLOOR PLAN"], ["", ""]]) {
    const page = doc.addPage([2592, 1728]);
    if (n) { page.drawText(t, { x: 2080, y: 230, size: 20, font }); page.drawText(n, { x: 2380, y: 90, size: 40, font }); }
  }
  const { openProject } = await import("./helpers");
  await openProject(owner, w, "Drawings");
  await owner.getByRole("button", { name: "Upload drawing set" }).click();
  await owner.getByLabel("Drawing set PDF").setInputFiles({ name: "IFC-set.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) });
  const review = owner.getByRole("form", { name: "Review drawing set" });
  await expect(review.getByLabel("Sheet number page 1")).toHaveValue("A-101");
  await expect(review.getByLabel("Title page 2")).toHaveValue("SECOND FLOOR PLAN");
  await expect(review.getByLabel("Sheet number page 3")).toHaveValue(""); // no text layer
  await review.getByLabel("Include page 3").uncheck();
  await review.getByLabel("Set name").fill("Issued for construction");
  await review.getByRole("button", { name: "Publish 2 sheet(s)" }).click();
  await expect(review.getByText("Published 2 sheet(s), 2 new.")).toBeVisible();
  await expect(owner.getByRole("link", { name: "A-102" })).toBeVisible();
});
