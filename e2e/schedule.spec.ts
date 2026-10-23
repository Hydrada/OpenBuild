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

test("working calendar: weekends and holidays push successors", async ({ browser }) => {
  const { api } = await import("./helpers");
  const w = await world(browser);
  const { owner } = w;
  const a = await api(owner).post(`/projects/${w.projectId}/schedule`, { name: "Framing", startDate: "2026-06-26", endDate: "2026-07-02" });
  await api(owner).post(`/projects/${w.projectId}/schedule`, { name: "Sheathing", startDate: "2026-06-29", endDate: "2026-06-30", predecessors: [{ id: a.id }] });
  await openProject(owner, w, "Schedule");
  await owner.getByRole("button", { name: "Working calendar" }).click();
  await owner.getByLabel("Sat is a working day").uncheck();
  await owner.getByLabel("Sun is a working day").uncheck();
  await owner.getByLabel(/Non-working days/).fill("2026-07-03 Independence Day (observed)");
  await owner.getByRole("button", { name: "Save calendar" }).click();
  await expect(owner.getByRole("row", { name: /Sheathing/ })).toContainText(new Date("2026-07-06T00:00:00").toLocaleDateString());
});

test("resource levelling: preview and apply", async ({ browser }) => {
  const { api } = await import("./helpers");
  const w = await world(browser);
  const { owner } = w;
  const crew = await api(owner).post(`/projects/${w.projectId}/resources`, { name: "Concrete crew", capacity: 1 });
  await api(owner).post(`/projects/${w.projectId}/schedule`, { name: "Footings", startDate: "2026-03-02", endDate: "2026-03-06", resourceId: crew.id });
  await api(owner).post(`/projects/${w.projectId}/schedule`, { name: "Slab on grade", startDate: "2026-03-03", endDate: "2026-03-05", resourceId: crew.id });
  await openProject(owner, w, "Schedule");
  const panel = owner.getByRole("region", { name: "Resources" });
  await expect(panel.getByText(/Slab on grade:/)).toBeVisible();
  await panel.getByRole("button", { name: "Apply levelling" }).click();
  await owner.getByRole("button", { name: "Confirm" }).click();
  await expect(panel.getByText("No over-allocations — nothing to level.")).toBeVisible();
  await expect(owner.getByRole("row", { name: /Slab on grade/ })).toContainText(new Date("2026-03-07T00:00:00").toLocaleDateString());
});

test("levelling splits a splittable activity around critical work", async ({ browser }) => {
  const { api } = await import("./helpers");
  const w = await world(browser);
  const { owner } = w;
  const crew = await api(owner).post(`/projects/${w.projectId}/resources`, { name: "Finishing crew", capacity: 1 });
  const a = await api(owner).post(`/projects/${w.projectId}/schedule`, { name: "Critical paint", startDate: "2026-03-03", endDate: "2026-03-04", resourceId: crew.id });
  await api(owner).post(`/projects/${w.projectId}/schedule`, { name: "Handover", startDate: "2026-03-05", endDate: "2026-03-20", predecessors: [{ id: a.id }] });
  await api(owner).post(`/projects/${w.projectId}/schedule`, { name: "Touch-ups", startDate: "2026-03-01", endDate: "2026-03-04", resourceId: crew.id, splittable: true });
  await openProject(owner, w, "Schedule");
  const panel = owner.getByRole("region", { name: "Resources" });
  await expect(panel.getByText(/Touch-ups:.*\(split into 2 parts\)/)).toBeVisible();
  await panel.getByRole("button", { name: "Apply levelling" }).click();
  await owner.getByRole("button", { name: "Confirm" }).click();
  await expect(owner.getByRole("row", { name: /Touch-ups/ })).toContainText("split:");
  await expect(panel.getByText("No over-allocations — nothing to level.")).toBeVisible();
});
