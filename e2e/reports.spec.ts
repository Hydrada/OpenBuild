import { expect, test } from "@playwright/test";
import { api, world } from "./helpers";

test("reports: build a cross-project report, group it, save it and download CSV", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const school = await api(owner).post(`/orgs/${w.orgId}/projects`, { name: "Elm School" });
  await api(owner).post(`/projects/${w.projectId}/rfis`, { subject: "Beam depth", question: "?" });
  await api(owner).post(`/projects/${w.projectId}/rfis`, { subject: "Slab edge", question: "?" });
  await api(owner).post(`/projects/${school.id}/rfis`, { subject: "Gym roof", question: "?" });

  await owner.goto("/reports");
  const b = owner.getByRole("region", { name: "Report builder" });
  await b.getByLabel("Data").selectOption({ label: "RFIs" });
  for (const c of ["#", "Assignee", "Created by", "Due"]) await b.getByRole("checkbox", { name: c, exact: true }).uncheck();
  await b.getByRole("checkbox", { name: "Project", exact: true }).check();
  await b.getByLabel("Group by").selectOption({ label: "Project" });
  await b.getByRole("button", { name: "Run report" }).click();
  await expect(b.getByRole("table", { name: "Summary by group" })).toContainText("Harbor Tower2");
  await expect(b.getByRole("table", { name: "Summary by group" })).toContainText("Elm School1");
  await expect(b.getByRole("table", { name: "Report results" }).getByRole("row")).toHaveCount(4);

  await b.getByLabel("Report name").fill("RFIs by project");
  await b.getByRole("button", { name: "Save report" }).click();
  await expect(b.getByText('Saved "RFIs by project"')).toBeVisible();
  await owner.getByRole("region", { name: "Saved reports" }).getByRole("link", { name: "RFIs by project" }).click();
  await expect(owner.getByRole("heading", { name: "RFIs by project" })).toBeVisible();
  const download = owner.waitForEvent("download");
  await owner.getByRole("link", { name: "Download CSV" }).click();
  expect((await download).suggestedFilename()).toBe("RFIs_by_project.csv");
});
