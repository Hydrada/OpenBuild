import { expect, test } from "@playwright/test";
import { openProject, world } from "./helpers";

test("schedule: activities, milestone, dependency conflict, dashboard milestone", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Schedule");
  await owner.getByRole("button", { name: "Add activity" }).click();
  await owner.getByLabel("Activity", { exact: true }).fill("Foundations");
  await owner.getByLabel("Start", { exact: true }).fill("2026-01-05");
  await owner.getByLabel("Finish (blank for milestone)").fill("2026-02-13");
  await owner.getByLabel("% complete").fill("100");
  await owner.getByRole("button", { name: "Add to schedule" }).click();
  await expect(owner.getByRole("cell", { name: "Foundations" })).toBeVisible();

  await owner.getByRole("button", { name: "Add activity" }).click();
  await owner.getByLabel("Activity", { exact: true }).fill("Steel erection");
  await owner.getByLabel("Start", { exact: true }).fill("2026-02-02");
  await owner.getByLabel("Finish (blank for milestone)").fill("2026-03-20");
  await owner.getByLabel(/Depends on/).selectOption({ label: "Foundations" });
  await owner.getByRole("button", { name: "Add to schedule" }).click();
  await expect(owner.getByText("Dependency conflict")).toBeVisible();

  const soon = new Date(Date.now() + 10 * 86_400_000).toLocaleDateString("en-CA");
  await owner.getByRole("button", { name: "Add activity" }).click();
  await owner.getByLabel("Activity", { exact: true }).fill("Top out");
  await owner.getByLabel("Start", { exact: true }).fill(soon);
  await owner.getByLabel("Milestone", { exact: true }).check();
  await owner.getByRole("button", { name: "Add to schedule" }).click();
  await expect(owner.getByRole("cell", { name: "◆ Top out" })).toBeVisible();
  await expect(owner.getByRole("img", { name: /Schedule bar chart/ })).toBeVisible();

  await owner.getByRole("row", { name: /Steel erection/ }).getByRole("button", { name: "Edit" }).click();
  await owner.getByLabel("Start", { exact: true }).fill("2026-02-16");
  await owner.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Dependency conflict")).toHaveCount(0);
  // Top out finishes last, so it is critical; Steel erection (March) has float.
  await expect(owner.getByRole("row", { name: /Top out/ }).getByText("Critical")).toBeVisible();
  await expect(owner.getByRole("row", { name: /Steel erection/ }).getByText("Critical")).toHaveCount(0);

  await owner.getByRole("link", { name: "Dashboard" }).click();
  await expect(owner.getByRole("link", { name: "Top out" })).toBeVisible();
});
