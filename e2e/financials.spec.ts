import { expect, test } from "@playwright/test";
import { openProject, tool, world } from "./helpers";

test("budget → subcontract → change order → pay application, with correct totals", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Budget");
  await owner.getByLabel("Cost codes — one per line: code,description").fill("03-300,Cast-in-place concrete\n05-120,Structural steel");
  await owner.getByRole("button", { name: "Import cost codes" }).click();
  await expect(owner.getByRole("rowheader", { name: /03-300/ })).toBeVisible();

  await owner.getByLabel("Original budget 03-300").fill("500000");
  await owner.getByRole("row", { name: /03-300/ }).getByRole("button", { name: "Save" }).click();
  await owner.getByLabel("Original budget 05-120").fill("300000.50");
  await owner.getByRole("row", { name: /05-120/ }).getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("row", { name: /Total/ })).toContainText("$800,000.50");
  owner.once("dialog", (d) => d.accept());
  await owner.getByRole("button", { name: "Lock budget" }).click();
  await expect(owner.getByText("Locked", { exact: true })).toBeVisible();

  // Subcontract
  await tool(owner, "Contracts").click();
  await owner.getByRole("button", { name: "New contract" }).click();
  await owner.getByLabel("Title").fill("Concrete package");
  await owner.getByLabel("Owner / vendor").fill("Acme Concrete");
  await owner.getByLabel("Retainage %").fill("10");
  await owner.getByLabel("Cost code line 1").selectOption({ label: "03-300 Cast-in-place concrete" });
  await owner.getByLabel("Description line 1").fill("Foundations and decks");
  await owner.getByLabel("Scheduled value line 1").fill("480,000");
  await owner.getByRole("button", { name: "Create contract" }).click();
  await owner.getByRole("link", { name: "1", exact: true }).click();
  await owner.getByRole("button", { name: "Approve contract" }).click();
  await expect(owner.getByRole("heading", { name: /Approved/ })).toBeVisible();

  // Change order
  await openProject(owner, w, "Change orders");
  await owner.getByRole("button", { name: "New change order" }).click();
  await owner.getByLabel("Contract").selectOption({ index: 1 });
  await owner.getByLabel("Title").fill("Rock removal");
  await owner.getByLabel("Cost code line 1").selectOption({ label: "03-300 Cast-in-place concrete" });
  await owner.getByLabel("Description line 1").fill("Rock removal at grid A");
  await owner.getByLabel("Amount line 1").fill("24500");
  await owner.getByRole("button", { name: "Create change order" }).click();
  await owner.getByRole("link", { name: "1", exact: true }).click();
  await owner.getByLabel("Approver", { exact: true }).selectOption({ label: "Olive Owner" });
  await owner.getByRole("button", { name: "Submit for approval" }).click();
  await owner.getByRole("button", { name: "Approved", exact: true }).click();
  await expect(owner.getByRole("heading", { name: /Rock removal Approved/ })).toBeVisible();

  // Pay application
  await openProject(owner, w, "Invoices");
  await owner.getByRole("button", { name: "New invoice" }).click();
  await owner.getByLabel("Contract").selectOption({ index: 1 });
  await owner.getByLabel("Period start").fill("2026-09-01");
  await owner.getByLabel("Period end").fill("2026-09-30");
  await owner.getByRole("button", { name: "Create invoice" }).click();
  await expect(owner.getByRole("heading", { name: /Invoice #1/ })).toBeVisible();
  await owner.getByLabel("This period Foundations and decks").fill("100000");
  await owner.getByLabel("Stored materials Foundations and decks").fill("20000");
  await owner.getByLabel("This period Rock removal at grid A").fill("10000");
  await owner.getByRole("button", { name: "Save amounts" }).click();
  const summary = owner.getByRole("region", { name: "Application summary" });
  await expect(summary).toContainText("$504,500.00"); // contract sum to date
  await expect(summary).toContainText("$130,000.00"); // completed & stored
  await expect(summary).toContainText("$13,000.00"); // retainage 10%
  await expect(summary).toContainText("$117,000.00"); // payment due
  await owner.getByLabel("Approver", { exact: true }).selectOption({ label: "Olive Owner" });
  await owner.getByRole("button", { name: "Submit for approval" }).click();
  await owner.getByRole("button", { name: "Approved", exact: true }).click();
  await owner.getByRole("button", { name: "Mark paid" }).click();
  await expect(owner.getByRole("heading", { name: /Invoice #1 Paid/ })).toBeVisible();
  const csv = owner.waitForEvent("download");
  await owner.getByRole("link", { name: "Export G703 CSV" }).click();
  expect((await csv).suggestedFilename()).toBe("pay-application-1.csv");

  // Budget reflects commitments and costs
  await openProject(owner, w, "Budget");
  const row = owner.getByRole("row", { name: /03-300/ });
  await expect(row).toContainText("$504,500.00"); // committed incl. approved CO
  await expect(row).toContainText("$130,000.00"); // cost to date
});
