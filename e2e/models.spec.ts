import { expect, test } from "@playwright/test";
import { openProject, world } from "./helpers";

const ifc = (walls: number) => ({
  name: "tower.ifc", mimeType: "application/octet-stream",
  buffer: Buffer.from(["ISO-10303-21;", "HEADER;", "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;",
    ...Array.from({ length: walls }, (_, i) => `#${i + 10}=IFCWALL('w${i}',$,'Wall',$,$,$,$,$,$);`), "ENDSEC;", "END-ISO-10303-21;"].join("\n")),
});

test("BIM models: upload, new version, element changes", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Models (BIM)");
  for (const [walls, note] of [[10, ""], [13, "Added core walls"]] as const) {
    await owner.getByRole("button", { name: "Upload model" }).click();
    await owner.getByLabel("Model name (same name adds a version)").fill("Architecture");
    if (note) await owner.getByLabel("What changed").fill(note);
    await owner.getByLabel("IFC file").setInputFiles(ifc(walls));
    await owner.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(owner.getByRole("cell", { name: `${walls} walls` })).toBeVisible();
  }
  await owner.getByRole("link", { name: "Architecture" }).click();
  await expect(owner.getByRole("region", { name: "Version 2" }).getByRole("cell", { name: "+3" })).toBeVisible();
  await expect(owner.getByText("Added core walls")).toBeVisible();
});
