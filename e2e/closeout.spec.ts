import { expect, test } from "@playwright/test";
import { ifcWithBoxes } from "../apps/api/test/ifc-fixture";
import { api, member, openProject, pdf, world } from "./helpers";

test("closeout plan: subcontractor uploads the O&M manual and completes their item", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const sub = await member(browser, w, "Mia Mechanical", "subcontractor");
  await openProject(owner, w, "Action plans");
  await owner.getByRole("button", { name: "New action plan" }).click();
  await owner.getByLabel("Title").fill("Project closeout");
  await owner.getByLabel(/Extra items/).fill("Mechanical: HVAC O&M manuals");
  await owner.getByRole("button", { name: "Create plan" }).click();
  await expect(owner.getByRole("heading", { name: "Project closeout" })).toBeVisible();
  await expect(owner.getByText("0 of 15 complete (0%)")).toBeVisible();
  await owner.getByLabel("Assignee for HVAC O&M manuals").selectOption({ label: "Mia Mechanical" });
  await expect(owner.getByLabel("Assignee for HVAC O&M manuals")).toHaveValue(sub.id);

  // A required document must be attached first.
  const planUrl = owner.url();
  await owner.getByRole("row", { name: /Operation and maintenance manuals/ }).getByRole("button", { name: "Mark done" }).click();
  await expect(owner.getByText("Attach the required document before completing this item")).toBeVisible();

  await sub.page.goto(planUrl);
  await expect(sub.page.getByRole("row", { name: /Punch list complete/ })).toHaveCount(0);
  await sub.page.getByLabel("Attach file to HVAC O&M manuals").setInputFiles(pdf("hvac-om"));
  await expect(sub.page.getByRole("row", { name: /HVAC O&M manuals/ })).toContainText("1 file(s)");
  await sub.page.getByRole("row", { name: /HVAC O&M manuals/ }).getByRole("button", { name: "Mark done" }).click();
  await expect(sub.page.getByRole("row", { name: /HVAC O&M manuals/ })).toContainText("Done");

  await owner.reload();
  await expect(owner.getByText("1 of 15 complete (6%)")).toBeVisible();
});

test("warranties: expiring soon is flagged", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Warranties");
  await owner.getByRole("button", { name: "Add warranty" }).click();
  await owner.getByLabel("Item / system").fill("Rooftop units");
  await owner.getByLabel("Warrantor").fill("CoolAir");
  await owner.getByLabel("Ends").fill(new Date(Date.now() + 20 * 86_400_000).toLocaleDateString("en-CA"));
  await owner.getByRole("button", { name: "Add warranty" }).last().click();
  await expect(owner.getByRole("row", { name: /Rooftop units/ })).toContainText("Expiring");
});

test("coordination: raise an issue from a clash, assignee sends it for review, author closes it", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const mech = await member(browser, w, "Mia Mechanical", "subcontractor");
  const file = (name: string, buf: Buffer) => ({ name, mimeType: "application/octet-stream", buffer: buf });
  await openProject(owner, w, "Models (BIM)");
  for (const [name, buf] of [
    ["Structure", ifcWithBoxes([{ name: "Beam B1", x: 0, y: 0, z: 3, dx: 6, dy: 0.3, dz: 0.5 }])],
    ["MEP", ifcWithBoxes([{ type: "IFCDUCTSEGMENT", name: "Duct D1", x: 2, y: -1, z: 3.1, dx: 0.4, dy: 3, dz: 0.3 }])],
  ] as const) {
    await owner.getByRole("button", { name: "Upload model" }).click();
    await owner.getByLabel("Model name (same name adds a version)").fill(name);
    await owner.getByLabel("IFC file").setInputFiles(file(`${name}.ifc`, buf));
    await owner.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(owner.getByRole("cell", { name, exact: true })).toBeVisible();
  }
  await owner.getByLabel("Model A").selectOption({ label: "Structure v1" });
  await owner.getByLabel("Model B").selectOption({ label: "MEP v1" });
  await owner.getByRole("button", { name: "Run clash detection" }).click();
  await owner.getByRole("row", { name: /Beam B1/ }).getByRole("button", { name: "Raise issue" }).click({ timeout: 20_000 }); // waits for the clash run
  await expect(owner.getByText("1 issue(s) raised")).toBeVisible();

  await openProject(owner, w, "Coordination issues");
  await owner.getByRole("link", { name: "1", exact: true }).click();
  await expect(owner.getByRole("heading", { name: /Beam B1 \(BuildingElementProxy\) × Duct D1 \(DuctSegment\)/ })).toBeVisible();
  await owner.getByLabel("Assignee").selectOption({ label: "Mia Mechanical" });
  await expect(owner.getByLabel("Assignee")).toHaveValue(mech.id);
  const issueUrl = owner.url();

  await mech.page.goto(issueUrl);
  await mech.page.getByRole("button", { name: "Ready for review" }).click();
  await expect(mech.page.getByRole("heading", { name: /Ready for review/ })).toBeVisible();
  await expect(mech.page.getByRole("button", { name: "Close" })).toHaveCount(0);

  await owner.reload();
  await owner.getByRole("button", { name: "Close" }).click();
  await expect(owner.getByRole("heading", { name: /Closed/ })).toBeVisible();
});

test("payroll export: overtime split and CSV download", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const worker = await member(browser, w, "Wes Worker", "contributor");
  for (const d of ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]) {
    const e = await api(worker.page).post(`/projects/${w.projectId}/timesheets`, { workDate: d, hours: "10" });
    await api(owner).post(`/timesheets/${e.id}/decide`, { decision: "approved" });
  }
  await openProject(owner, w, "Timesheets");
  const payroll = owner.getByRole("region", { name: "Payroll export" });
  await payroll.getByLabel("From").fill("2026-10-01");
  await payroll.getByLabel("To").fill("2026-10-31");
  await expect(payroll).toContainText("5 entries · regular 40.00 h · overtime 10.00 h");
  const download = owner.waitForEvent("download");
  await payroll.getByRole("link", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("payroll-2026-10-01-to-2026-10-31.csv");
  await payroll.getByRole("button", { name: "Mark as sent to payroll" }).click();
  await expect(payroll).toContainText("5 marked as sent");
  await expect(payroll).toContainText("5 already sent to payroll");
});
