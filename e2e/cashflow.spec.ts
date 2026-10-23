import { expect, test } from "@playwright/test";
import { api, openProject, world } from "./helpers";

test("cash flow: spread a cost code front-loaded and see the monthly forecast", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await owner.request.patch(`/api/projects/${w.projectId}`, { headers: { "x-openbuild-csrf": "1" }, data: { startDate: "2026-10-01", endDate: "2026-12-31" } });
  await api(owner).post(`/projects/${w.projectId}/cost-codes`, { code: "03-300", description: "Concrete" });
  const cc = (await api(owner).get(`/projects/${w.projectId}/cost-codes`))[0].id;
  await owner.request.put(`/api/projects/${w.projectId}/budget/lines/${cc}`, { headers: { "x-openbuild-csrf": "1" }, data: { originalAmount: "90000.00" } });
  await openProject(owner, w, "Cash flow");
  const cf = owner.getByRole("region", { name: "Cash flow" });
  await expect(cf.getByRole("table", { name: "Monthly cash flow" })).toContainText("$30,000.00");
  await cf.getByRole("row", { name: /03-300/ }).getByRole("button", { name: "Change" }).click();
  await cf.getByLabel("Curve for 03-300").selectOption("front");
  await cf.getByRole("button", { name: "Save" }).click();
  await expect(cf.getByRole("row", { name: /03-300/ })).toContainText("Front");
  await expect(cf.getByRole("img", { name: /forecast \$90,000\.00/ })).toBeVisible();
  await expect(cf.getByRole("table", { name: "Monthly cash flow" }).getByRole("row", { name: /2026-10/ })).toContainText("$42,000.00"); // front-loaded: 42k / 30k / 18k
});
