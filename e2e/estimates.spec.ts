import { expect, test } from "@playwright/test";
import { api, openProject, world } from "./helpers";

test("estimating: catalog item, priced lines with markup, send to budget", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await api(owner).post(`/projects/${w.projectId}/cost-codes`, { code: "03-300", description: "Concrete" });
  await api(owner).post(`/orgs/${w.orgId}/cost-catalog`, { name: "Ready-mix 4000 psi", category: "material", unit: "CY", unitCost: "145.25" });
  await openProject(owner, w, "Estimating");
  await owner.getByRole("button", { name: "New estimate" }).click();
  await owner.getByLabel("Name").fill("GMP v1");
  await owner.getByRole("button", { name: "Create estimate" }).click();
  await owner.getByLabel("Add from cost catalog").selectOption({ label: "Ready-mix 4000 psi (CY @ 145.25)" });
  await owner.getByLabel("Quantity line 1").fill("88.5");
  await owner.getByLabel("Cost code line 1").selectOption({ label: "03-300 Concrete" });
  await owner.getByRole("button", { name: "Save lines" }).click();
  const summary = owner.getByRole("region", { name: "Estimate summary" });
  await expect(summary).toContainText("$12,854.62");
  await expect(summary).toContainText("$16,125.08"); // 10% OH, 5% cont., 8% profit, 1% bond, half-even at each step
  await owner.getByRole("button", { name: "Send to budget" }).click();
  await owner.getByRole("button", { name: "Confirm" }).click();
  await expect(owner.getByRole("heading", { name: /GMP v1/ })).toContainText("Final");
  await openProject(owner, w, "Budget");
  await expect(owner.getByRole("row", { name: /03-300/ })).toContainText("16,125.08");
});
