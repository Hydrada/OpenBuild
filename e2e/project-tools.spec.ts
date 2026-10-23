import { expect, test } from "@playwright/test";
import { api, member, openProject, world } from "./helpers";

test("correspondence: send a transmittal, the subcontractor acknowledges it", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const sub = await member(browser, w, "Sam Steel", "subcontractor");
  await openProject(owner, w, "Correspondence");
  await owner.getByRole("button", { name: "New correspondence" }).click();
  await owner.getByLabel("Subject").fill("Structural shop drawings, set 1");
  await owner.getByLabel(/^To/).selectOption({ label: "Sam Steel" });
  await owner.getByLabel("Message").fill("Attached for your review.");
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(owner.getByRole("cell", { name: "TR-001" })).toBeVisible();
  await expect(owner.getByRole("row", { name: /TR-001/ })).toContainText("0/1");

  await sub.page.goto(`/projects/${w.projectId}/correspondence`);
  await sub.page.getByRole("link", { name: "TR-001" }).click();
  await sub.page.getByRole("button", { name: "Acknowledge receipt" }).click();
  await expect(sub.page.getByRole("button", { name: "Acknowledge receipt" })).toHaveCount(0);

  await owner.reload();
  await expect(owner.getByRole("row", { name: /TR-001/ })).toContainText("1/1");
});

test("direct costs flow into the budget once approved", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await api(owner).post(`/projects/${w.projectId}/cost-codes`, { code: "01-500", description: "General conditions" });
  const pm = await member(browser, w, "Pat Manager", "manager");
  await openProject(pm.page, w, "Direct costs");
  await pm.page.getByRole("button", { name: "New direct cost" }).click();
  await pm.page.getByLabel("Cost code").selectOption({ label: "01-500 General conditions" });
  await pm.page.getByLabel("Amount").fill("1,250.40");
  await pm.page.getByLabel("Vendor / employee").fill("United Rentals");
  await pm.page.getByLabel("Description").fill("Temporary fencing");
  await pm.page.getByRole("button", { name: "Add cost" }).click();
  await expect(pm.page.getByRole("row", { name: /Temporary fencing/ })).toContainText("Pending");

  await openProject(owner, w, "Direct costs");
  await owner.getByRole("row", { name: /Temporary fencing/ }).getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByRole("row", { name: /Temporary fencing/ })).toContainText("Approved");
  await openProject(owner, w, "Budget");
  await expect(owner.getByRole("row", { name: /01-500/ })).toContainText("1,250.40");
});

test("T&M ticket: lines, field signature, approval and change event", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await api(owner).post(`/projects/${w.projectId}/cost-codes`, { code: "03-300", description: "Concrete" });
  await openProject(owner, w, "T&M tickets");
  await owner.getByRole("button", { name: "New T&M ticket" }).click();
  await owner.getByLabel("Performed by (company)").fill("Acme Concrete");
  await owner.getByLabel("Work performed").fill("Extra core drilling at level 2");
  await owner.getByLabel("Description line 1").fill("Carpenter");
  await owner.getByLabel("Quantity line 1").fill("6.5");
  await owner.getByLabel("Rate line 1").fill("87.25");
  await owner.getByLabel("Cost code line 1").selectOption({ label: "03-300 Concrete" });
  await owner.getByRole("button", { name: "Add line" }).click();
  await owner.getByLabel("Type line 2").selectOption("material");
  await owner.getByLabel("Description line 2").fill("Grout");
  await owner.getByLabel("Quantity line 2").fill("3");
  await owner.getByLabel("Rate line 2").fill("19.99");
  await owner.getByLabel("Cost code line 2").selectOption({ label: "03-300 Concrete" });
  await owner.getByRole("button", { name: "Create ticket" }).click();
  await expect(owner.getByRole("row", { name: /core drilling/ })).toContainText("627.09");

  await owner.getByRole("row", { name: /core drilling/ }).getByRole("link").click();
  await owner.getByLabel("Signed in the field by").fill("Riley Rep (owner)");
  await owner.getByRole("button", { name: "Submit ticket" }).click();
  await owner.getByRole("button", { name: "Approve" }).click();
  await owner.getByRole("button", { name: "Create change event" }).click();
  await expect(owner.getByRole("link", { name: "#1" })).toBeVisible();
});

test("equipment: register and log hours", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Equipment");
  await owner.getByRole("button", { name: "Add equipment" }).click();
  await owner.getByLabel("Name").fill("CAT 320 excavator");
  await owner.getByLabel("Hourly rate").fill("112.50");
  await owner.getByRole("button", { name: "Add equipment" }).last().click();
  await owner.getByRole("link", { name: "CAT 320 excavator" }).click();
  await owner.getByLabel("Hours operated").fill("7.5");
  await owner.getByRole("button", { name: "Log hours" }).click();
  await expect(owner.getByRole("table", { name: "Usage log" })).toContainText("7.50");
  await expect(owner.getByText(/843\.75/)).toBeVisible();
});
