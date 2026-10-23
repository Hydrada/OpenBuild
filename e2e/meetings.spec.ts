import { expect, test } from "@playwright/test";
import { totp } from "../apps/api/src/lib/totp";
import { member, openProject, PASSWORD, world } from "./helpers";

test("meeting minutes with an action item, published to attendees", async ({ browser }) => {
  const w = await world(browser);
  const pm = await member(browser, w, "Pat Manager", "manager");
  const { owner } = w;
  await openProject(owner, w, "Meetings");
  await owner.getByRole("button", { name: "New meeting" }).click();
  await owner.getByLabel("Title", { exact: true }).fill("OAC meeting #12");
  await owner.getByLabel("Agenda (one topic per line)").fill("Safety\nSchedule");
  await owner.getByRole("checkbox", { name: "Pat Manager" }).check();
  await owner.getByRole("button", { name: "Create meeting" }).click();
  await owner.getByRole("link", { name: "OAC meeting #12" }).click();
  await owner.getByLabel("Notes for Safety").fill("No incidents this week");
  await owner.getByLabel("Notes for Safety").blur();
  await owner.getByLabel("Topic / action").fill("Confirm crane date");
  await owner.getByLabel("Action owner").selectOption({ label: "Pat Manager" });
  await owner.getByRole("button", { name: "Add item" }).click();
  await expect(owner.getByRole("cell", { name: "Confirm crane date" })).toBeVisible();
  owner.once("dialog", (d) => d.accept());
  await owner.getByRole("button", { name: "Publish minutes" }).click();
  await expect(owner.getByRole("heading", { name: /Minutes published/ })).toBeVisible();
  await expect(owner.getByText("No incidents this week")).toBeVisible();

  await pm.page.goto("/notifications");
  await pm.page.getByRole("link", { name: /Minutes published: OAC meeting #12/ }).click();
  await expect(pm.page.getByRole("cell", { name: "Confirm crane date" })).toBeVisible();
});

test("timesheets: sub logs time, manager approves", async ({ browser }) => {
  const w = await world(browser);
  const sub = await member(browser, w, "Sam Sub", "subcontractor");
  await openProject(sub.page, w, "Timesheets");
  await sub.page.getByRole("button", { name: "Log time" }).click();
  await sub.page.getByLabel("Hours").fill("7.75");
  await sub.page.getByLabel("Work done").fill("Conduit rough-in");
  await sub.page.getByRole("button", { name: "Save time" }).click();
  await expect(sub.page.getByText("approved 0.00 h of 7.75 h")).toBeVisible();
  await expect(sub.page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  await openProject(w.owner, w, "Timesheets");
  await w.owner.getByRole("row", { name: /Sam Sub/ }).getByRole("button", { name: "Approve" }).click();
  await expect(w.owner.getByText("approved 7.75 h of 7.75 h")).toBeVisible();
});

test("two-factor login: enrol, then sign in with a code", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await owner.goto("/account");
  await owner.getByRole("button", { name: "Set up two-factor login" }).click();
  const secret = (await owner.getByLabel("Setup key").textContent())!.replace(/\s/g, "");
  await owner.getByLabel("6-digit code").fill(totp(secret));
  await owner.getByRole("button", { name: "Turn on two-factor login" }).click();
  await expect(owner.getByRole("button", { name: "Turn off two-factor login" })).toBeVisible();

  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto("/");
  await fresh.getByLabel("Email").fill(w.email);
  await fresh.getByLabel("Password").fill(PASSWORD);
  await fresh.getByRole("button", { name: "Sign in" }).click();
  await expect(fresh.getByText("Enter the 6-digit code")).toBeVisible();
  await fresh.getByLabel("Authentication code").fill(totp(secret));
  await fresh.getByRole("button", { name: "Sign in" }).click();
  await expect(fresh.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});
