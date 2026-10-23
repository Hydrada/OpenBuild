import { expect, test } from "@playwright/test";
import { api, member, openProject, world } from "./helpers";

test("crews: admin adds workers, manager builds a crew, foreman submits crew time, manager approves", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const foreman = await member(browser, w, "Fred Foreman", "contributor");

  await owner.goto("/team");
  const dir = owner.getByRole("region", { name: "Field workers" });
  for (const [name, num] of [["Ana Laborer", "E-100"], ["Bo Carpenter", "E-101"]]) {
    await dir.getByLabel("Worker name").fill(name);
    await dir.getByLabel("Employee #").fill(num);
    await dir.getByRole("button", { name: "Add worker" }).click();
    await expect(dir.getByRole("cell", { name })).toBeVisible();
  }

  await openProject(owner, w, "Timesheets");
  await owner.getByRole("button", { name: "New crew" }).click();
  await owner.getByLabel("Crew name").fill("Concrete A");
  await owner.getByLabel("Foreman").selectOption({ label: "Fred Foreman" });
  await owner.getByLabel(/^Workers/).selectOption([{ label: "Ana Laborer" }, { label: "Bo Carpenter" }]);
  await owner.getByRole("button", { name: "Create crew" }).click();
  await expect(owner.getByRole("row", { name: /Concrete A/ })).toContainText("Ana Laborer, Bo Carpenter");

  await openProject(foreman.page, w, "Timesheets");
  const sheet = foreman.page.getByRole("region", { name: "Crew timesheet" });
  await sheet.getByLabel("Date").fill("2026-10-05");
  await sheet.getByRole("button", { name: "Everyone 8 h" }).click();
  await sheet.getByLabel("Hours for Bo Carpenter").fill("10");
  await sheet.getByRole("button", { name: "Submit crew time" }).click();
  await expect(sheet.getByText("2 entries sent for approval")).toBeVisible();
  await expect(foreman.page.getByRole("table", { name: "Timesheet entries" }).getByRole("row", { name: /Bo Carpenter/ })).toContainText("entered by Fred Foreman");

  await owner.reload();
  const row = owner.getByRole("table", { name: "Timesheet entries" }).getByRole("row", { name: /Bo Carpenter/ });
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row).toContainText("Approved");
  const entries = (await api(owner).get(`/projects/${w.projectId}/timesheets`)).entries;
  expect(entries.map((e: { worker_name: string; hours: string }) => [e.worker_name, e.hours]).sort()).toEqual([["Ana Laborer", "8.00"], ["Bo Carpenter", "10.00"]]);
});
