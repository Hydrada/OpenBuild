import { expect, test } from "@playwright/test";
import { api, jpeg, openProject, world } from "./helpers";

test("photos: album, caption and tag, then filter", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Photos");
  await owner.getByLabel("Upload photos").setInputFiles([jpeg("pump"), jpeg("roof")]);
  await expect(owner.locator(".gallery li")).toHaveCount(2);
  await owner.getByLabel("New album name").fill("Level 3 pour");
  await owner.getByRole("button", { name: "Add album" }).click();
  const pump = owner.locator(".gallery li", { hasText: "pump.jpg" });
  await pump.getByText("Edit details").click();
  await pump.getByLabel("Caption").fill("Pump truck set up");
  await pump.getByLabel("Tags (comma separated)").fill("concrete, L3");
  await pump.getByLabel("Album").selectOption({ label: "Level 3 pour" });
  await pump.getByRole("button", { name: "Save" }).click();
  await expect(owner.locator(".gallery li", { hasText: "Pump truck set up" })).toContainText("#concrete");

  await owner.getByLabel("Filter by album").selectOption({ label: "Level 3 pour" });
  await expect(owner.locator(".gallery li")).toHaveCount(1);
  await owner.getByLabel("Filter by album").selectOption({ label: "All" });
  await owner.locator(".gallery li", { hasText: "Pump truck set up" }).getByRole("button", { name: "#l3" }).click();
  await expect(owner.locator(".gallery li")).toHaveCount(1);
});

test("daily log: deliveries and quantities, with the day's equipment hours", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const log = await api(owner).post(`/projects/${w.projectId}/daily-logs`, { logDate: "2026-10-05" });
  const eq = await api(owner).post(`/projects/${w.projectId}/equipment`, { name: "Concrete pump" });
  await api(owner).post(`/equipment/${eq.id}/logs`, { logDate: "2026-10-05", hoursOperated: 6 });
  await owner.goto(`/daily-logs/${log.id}`);
  const deliveries = owner.getByRole("region", { name: "Deliveries" });
  await deliveries.getByLabel("Time (HH:MM)").fill("07:15");
  await deliveries.getByLabel("Supplier").fill("Ready Mix Co");
  await deliveries.getByLabel("Description").fill("9 trucks, 90 CY");
  await deliveries.getByRole("button", { name: "Add" }).click();
  await expect(deliveries.getByRole("row", { name: /Ready Mix Co/ })).toContainText("07:15");
  const qty = owner.getByRole("region", { name: "Quantities installed" });
  await qty.getByLabel("Description").fill("Slab on deck L3");
  await qty.getByLabel("Quantity").fill("88.5");
  await qty.getByLabel("Unit").fill("CY");
  await qty.getByRole("button", { name: "Add" }).click();
  await expect(qty.getByRole("row", { name: /Slab on deck/ })).toContainText("88.50 CY");
  await expect(owner.getByRole("region", { name: "Equipment on site" })).toContainText("Concrete pump");
});
