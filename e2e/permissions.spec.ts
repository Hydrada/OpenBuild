import { expect, test } from "@playwright/test";
import { member, openProject, tool, world } from "./helpers";

test("permission template: admin builds one, PM assigns it, the member loses Budget and can only read RFIs", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const fe = await member(browser, w, "Finn Engineer", "contributor");

  await owner.goto("/settings");
  const sec = owner.getByRole("region", { name: "Permission templates" });
  await sec.getByRole("button", { name: "New template" }).click();
  const form = owner.getByRole("form", { name: "Edit permission template" });
  await form.getByLabel("Template name").fill("Field engineer");
  await form.getByLabel("Level for Budget, cost codes and direct costs").selectOption("none");
  await form.getByLabel("Level for RFIs").selectOption("read");
  await form.getByRole("button", { name: "Save template" }).click();
  await expect(sec.getByRole("row", { name: /Field engineer/ })).toContainText("RFIs: read");

  await openProject(owner, w, "Team");
  await owner.getByLabel("Permission template of Finn Engineer").selectOption({ label: "Field engineer" });
  await expect(owner.getByLabel("Permission template of Finn Engineer")).not.toHaveValue("");

  await openProject(fe.page, w);
  await expect(tool(fe.page, "RFIs")).toBeVisible();
  await expect(tool(fe.page, "Budget")).toHaveCount(0);
  await expect(tool(fe.page, "Direct costs")).toHaveCount(0);
  const res = await fe.page.request.post(`/api/projects/${w.projectId}/rfis`, { headers: { "x-openbuild-csrf": "1" }, data: { subject: "x", question: "y" } });
  expect(res.status()).toBe(403);
});
