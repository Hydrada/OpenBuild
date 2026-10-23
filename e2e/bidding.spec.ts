import { expect, test } from "@playwright/test";
import { api, openProject, world } from "./helpers";

test("bid package: invite, bidder submits via private link, level and award", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await api(owner).post(`/projects/${w.projectId}/cost-codes`, { code: "09-900", description: "Painting" });
  await openProject(owner, w, "Bidding");
  await owner.getByRole("button", { name: "New bid package" }).click();
  await owner.getByLabel("Package title").fill("Interior painting");
  await owner.getByLabel("Cost code (for the awarded subcontract)").selectOption({ label: "09-900 Painting" });
  await owner.getByLabel("Scope of work").fill("Two coats, all interior walls");
  await owner.getByRole("button", { name: "Create package" }).click();
  await owner.getByRole("link", { name: "1", exact: true }).click();

  await owner.getByLabel("Company", { exact: true }).fill("Alpha Painting");
  await owner.getByLabel("Estimator email").fill("est@alpha.test");
  await owner.getByRole("button", { name: "Invite bidder" }).click();
  const link = await owner.getByLabel("Bid link").inputValue();

  const bidder = await (await browser.newContext()).newPage(); // not signed in
  await bidder.goto(link);
  await expect(bidder.getByRole("heading", { name: "Bid: Interior painting" })).toBeVisible();
  await bidder.getByLabel("Lump-sum amount (USD)").fill("48,250.00");
  await bidder.getByLabel("Inclusions / exclusions").fill("Excludes ceilings");
  await bidder.getByRole("button", { name: "Submit bid" }).click();
  await expect(bidder.getByText("Thank you — your bid was received.")).toBeVisible();

  await owner.reload();
  const row = owner.getByRole("row", { name: /Alpha Painting/ });
  await expect(row).toContainText("$48,250.00");
  await row.getByRole("button", { name: "Award" }).click();
  await owner.getByRole("button", { name: "Confirm" }).click();
  await expect(owner.getByText(/Awarded — subcontract/)).toBeVisible();
  await owner.getByRole("link", { name: /subcontract #1/ }).click();
  await expect(owner.getByRole("heading", { name: /Subcontract #1: Interior painting/ })).toBeVisible();

  await bidder.reload();
  await expect(bidder.getByText("Bidding on this package is closed.")).toBeVisible();
});
