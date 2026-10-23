import { expect, test } from "@playwright/test";
import { openProject, world } from "./helpers";

test("forms: admin builds a template, a form is filled, required fields enforced, submitted", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await owner.goto("/settings");
  const b = owner.getByRole("form", { name: "New form template" });
  await b.getByLabel("Form name").fill("Hot work permit");
  await b.getByRole("button", { name: "Add question" }).click();
  await b.getByLabel("Field 1 label").fill("Permit number");
  await b.getByRole("checkbox", { name: "Required" }).first().check();
  await b.getByRole("button", { name: "Add question" }).click();
  await b.getByLabel("Field 2 label").fill("Area");
  await b.getByLabel("Field 2 type").selectOption("select");
  await b.getByLabel("Field 2 options").fill("Roof, Basement");
  await b.getByRole("button", { name: "Add question" }).click();
  await b.getByLabel("Field 3 label").fill("Approved by");
  await b.getByLabel("Field 3 type").selectOption("signature");
  await b.getByRole("button", { name: "Save form template" }).click();
  await expect(owner.getByRole("region", { name: "Form templates" }).getByRole("cell", { name: "Hot work permit" })).toBeVisible();

  await openProject(owner, w, "Forms");
  await owner.getByRole("button", { name: "Start form" }).click();
  await owner.getByLabel("Form", { exact: true }).selectOption({ label: "Hot work permit" });
  await owner.getByRole("button", { name: "Start" }).click();
  const f = owner.getByRole("form", { name: "Form answers" });
  await f.getByRole("button", { name: "Submit form" }).click();
  await expect(f.getByText('"Permit number" is required')).toBeVisible();
  await f.getByLabel("Permit number *").fill("HW-12");
  await f.getByLabel("Area").selectOption("Roof");
  await f.getByLabel(/Approved by/).fill("Sam Super");
  await f.getByRole("button", { name: "Submit form" }).click();
  await expect(owner.getByRole("heading", { name: /Form #1: Hot work permit/ })).toContainText("Submitted");
  await expect(f).toContainText("Signed: Sam Super");
});
