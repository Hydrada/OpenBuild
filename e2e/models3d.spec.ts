import { expect, test } from "@playwright/test";
import { ifcWithBoxes } from "../apps/api/test/ifc-fixture";
import { openProject, world } from "./helpers";

test("BIM: 3D viewer renders the model and clash detection runs from the UI", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const file = (name: string, buf: Buffer) => ({ name, mimeType: "application/octet-stream", buffer: buf });
  const arch = ifcWithBoxes([{ name: "Beam B1", x: 0, y: 0, z: 3, dx: 6, dy: 0.3, dz: 0.5 }, { type: "IFCWALL", name: "Wall W1", x: 10, y: 0, z: 0, dx: 0.2, dy: 5, dz: 3 }]);
  const mep = ifcWithBoxes([{ type: "IFCDUCTSEGMENT", name: "Duct D1", x: 2, y: -1, z: 3.1, dx: 0.4, dy: 3, dz: 0.3 }]);
  await openProject(owner, w, "Models (BIM)");
  for (const [name, buf] of [["Architecture", arch], ["MEP", mep]] as const) {
    await owner.getByRole("button", { name: "Upload model" }).click();
    await owner.getByLabel("Model name (same name adds a version)").fill(name);
    await owner.getByLabel("IFC file").setInputFiles(file(`${name}.ifc`, buf));
    await owner.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(owner.getByRole("cell", { name, exact: true })).toBeVisible();
  }
  await owner.getByLabel("Model A").selectOption({ label: "Architecture v1" });
  await owner.getByLabel("Model B").selectOption({ label: "MEP v1" });
  await owner.getByRole("button", { name: "Run clash detection" }).click();
  await expect(owner.getByText(/Architecture v1 × MEP v1/)).toBeVisible({ timeout: 20_000 }); // clash detection parses both models
  await expect(owner.getByRole("cell", { name: /Beam B1/ })).toBeVisible();
  await expect(owner.getByRole("cell", { name: /Duct D1/ })).toBeVisible();
  await expect(owner.getByRole("cell", { name: "Geometry" })).toBeVisible();

  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  await owner.getByRole("link", { name: "Architecture" }).click();
  await owner.getByRole("button", { name: "View in 3D" }).click();
  await expect(owner.getByRole("img", { name: /3D model with 2 elements/ })).toBeVisible({ timeout: 30_000 });
  // The canvas really drew something: sample pixels and look for the red clash highlight and non-background colour.
  const stats = await owner.locator(".model-canvas canvas").evaluate((c: HTMLCanvasElement) => {
    const g = c.getContext("webgl2") ?? c.getContext("webgl");
    if (!g) return { drawn: 0, red: 0 };
    const px = new Uint8Array(c.width * c.height * 4);
    g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
    let drawn = 0, red = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, gg, b] = [px[i]!, px[i + 1]!, px[i + 2]!];
      if (Math.abs(r - 242) + Math.abs(gg - 244) + Math.abs(b - 247) > 30) drawn++;
      if (r > 120 && gg < 70 && b < 70) red++;
    }
    return { drawn, red };
  });
  expect(stats.drawn).toBeGreaterThan(500);
  expect(stats.red).toBeGreaterThan(50); // Beam B1 clashes, so it is highlighted
  expect(errors).toEqual([]);
});
