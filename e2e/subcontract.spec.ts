import { expect, test } from "@playwright/test";
import { api, member, openProject, pdf, world } from "./helpers";

test("subcontractor invoicing: contact set by the PM, sub bills and uploads insurance, PM accepts", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const sub = await member(browser, w, "Sam Concrete", "subcontractor", { company: "Acme Concrete" });
  await api(owner).post(`/projects/${w.projectId}/cost-codes`, { code: "03-300", description: "Concrete" });
  const cc = (await api(owner).get(`/projects/${w.projectId}/cost-codes`))[0].id;
  const k = await api(owner).post(`/projects/${w.projectId}/contracts`, { kind: "subcontract", title: "Concrete package", counterparty: "Acme Concrete", retainagePercent: "10", lines: [{ costCodeId: cc, description: "Foundations", amount: "100000" }] });
  await api(owner).post(`/contracts/${k.id}/status`, { status: "approved" });

  await owner.goto(`/contracts/${k.id}`);
  const contacts = owner.getByRole("region", { name: "Invoice contacts" });
  await contacts.getByLabel(/^Contacts/).selectOption({ label: "Sam Concrete (Acme Concrete)" });
  await contacts.getByRole("button", { name: "Save contacts" }).click();
  await expect(contacts.getByText("Contacts saved")).toBeVisible();
  await owner.getByRole("region", { name: "Insurance and compliance" }).getByLabel("Require insurance before payment").check();

  // The subcontractor only sees their own commitment under "My contracts".
  await openProject(sub.page, w, "My contracts");
  const mine = sub.page.getByRole("region", { name: "Contract Concrete package" });
  await expect(mine).toContainText("$100,000.00");
  await mine.getByLabel("Period from").fill("2026-10-01");
  await mine.getByLabel("Period to").fill("2026-10-31");
  await mine.getByRole("button", { name: "Start pay application" }).click();
  await sub.page.getByLabel("This period Foundations").fill("20000");
  await sub.page.getByRole("button", { name: "Save amounts" }).click();
  await expect(sub.page.getByRole("region", { name: "Application summary" })).toContainText("$18,000.00");
  await sub.page.getByRole("button", { name: "Submit pay application" }).click();
  await expect(sub.page.getByRole("heading", { name: /Invoice #1/ })).toContainText("Submitted");

  // Insurance certificate with the PDF attached.
  await openProject(sub.page, w, "My contracts");
  const comp = sub.page.getByRole("region", { name: "Insurance and compliance" });
  await comp.getByLabel("Carrier").fill("Travelers");
  await comp.getByLabel("Expires").fill("2027-06-30");
  await comp.getByLabel("Certificate file").setInputFiles(pdf("coi"));
  await comp.getByRole("button", { name: "Add document" }).click();
  await expect(comp.getByRole("link", { name: "coi.pdf" })).toBeVisible();

  await owner.reload();
  const ownerComp = owner.getByRole("region", { name: "Insurance and compliance" });
  await ownerComp.getByRole("row", { name: /General liability/ }).getByRole("button", { name: "Accept" }).click();
  await expect(ownerComp.getByRole("row", { name: /General liability/ })).toContainText("Accepted");
  await owner.goto("/notifications");
  await expect(owner.getByText(/Invoice #1 needs your approval/).first()).toBeVisible();
});
