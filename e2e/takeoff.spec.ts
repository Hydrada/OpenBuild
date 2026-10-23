import { expect, test } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";
import { api, openProject, world } from "./helpers";

test("takeoff: calibrate a sheet, measure a wall, use it in an estimate", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const doc = await PDFDocument.create();
  const page = doc.addPage([2592, 1728]); // 36 x 24 in
  page.drawRectangle({ x: 259, y: 400, width: 1296, height: 12, color: rgb(0, 0, 0) });
  const r = await owner.request.post(`/api/projects/${w.projectId}/drawings`, { headers: { "x-openbuild-csrf": "1" }, multipart: { number: "A-101", title: "Plan", revision: "0", file: { name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) } } });
  expect(r.ok()).toBe(true);
  await api(owner).post(`/projects/${w.projectId}/cost-codes`, { code: "09-200", description: "Drywall" });
  const drawingId = (await api(owner).get(`/projects/${w.projectId}/drawings`))[0].id;
  await owner.goto(`/drawings/${drawingId}`);
  const viewer = owner.getByRole("region", { name: "Sheet viewer" });
  await expect(viewer.getByRole("img", { name: "Sheet A-101 revision 0" })).toBeVisible({ timeout: 20_000 });
  const layer = viewer.getByRole("application", { name: "Takeoff layer" });
  const box = (await layer.boundingBox())!;
  const at = (fx: number, fy: number) => owner.mouse.click(box.x + box.width * fx, box.y + box.height * fy);

  await viewer.getByRole("button", { name: "Set scale" }).click();
  await at(0.1, 0.3); await at(0.6, 0.3);
  await viewer.getByLabel("Known distance").fill("30");
  await viewer.getByRole("button", { name: "Save measurement" }).click();
  await expect(viewer.getByText("Scale set (ft)")).toBeVisible();

  await viewer.getByRole("button", { name: "Measure length" }).click();
  await at(0.1, 0.3); await at(0.6, 0.3); await at(0.6, 0.45);
  await viewer.getByLabel("Measurement name").fill("Partition wall");
  await viewer.getByRole("button", { name: "Save measurement" }).click();
  await expect(layer).toContainText(/Partition wall: 3[5-7](\.\d+)? ft/); // ~36 ft (30 + 0.15 x 40), within a click's precision
  await viewer.screenshot({ path: "test-results/takeoff.png" });

  await openProject(owner, w, "Estimating");
  await owner.getByRole("button", { name: "New estimate" }).click();
  await owner.getByLabel("Name").fill("Interiors");
  await owner.getByRole("button", { name: "Create estimate" }).click();
  await owner.getByLabel("Add from takeoff").selectOption({ index: 1 });
  await expect(owner.getByLabel("Description line 1")).toHaveValue("Partition wall (A-101)");
  await expect(owner.getByLabel("Unit line 1")).toHaveValue("ft");
});
