import { expect, test } from "@playwright/test";

test("owner sets up a company, project and task; invited viewer is read-only", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();

  await owner.goto("/");
  await owner.getByRole("button", { name: "New here? Create an organization" }).click();
  await owner.getByLabel("Your name").fill("Olive Owner");
  await owner.getByLabel("Company name").fill("Acme Builders");
  await owner.getByLabel("Email").fill("olive@acme.test");
  await owner.getByLabel("Password").fill("correct horse battery");
  await owner.getByRole("button", { name: "Create account" }).click();
  await expect(owner.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await owner.getByRole("link", { name: "Projects" }).click();
  await owner.getByRole("button", { name: "New project" }).click();
  await owner.getByLabel("Project name").fill("Harbor Tower");
  await owner.getByLabel("Project number").fill("HT-01");
  await owner.getByRole("button", { name: "Create project" }).click();
  await expect(owner.getByRole("heading", { name: /Harbor Tower/ })).toBeVisible();

  await owner.getByLabel("Task title").fill("Pour level 2 slab");
  await owner.getByLabel("Assignee").selectOption({ label: "Olive Owner" });
  await owner.getByLabel("Due date").fill("2020-01-15");
  await owner.getByRole("button", { name: "Add task" }).click();
  await expect(owner.getByRole("cell", { name: "Pour level 2 slab" })).toBeVisible();

  await owner.getByRole("link", { name: "Dashboard" }).click();
  await expect(owner.locator(".stat.warn .stat-value")).toHaveText("1"); // overdue

  // Invite a viewer to the project
  await owner.getByRole("link", { name: "Team" }).click();
  await owner.getByLabel("Email").fill("val@sub.test");
  await owner.getByLabel("Add to project (optional)").selectOption({ label: "Harbor Tower" });
  await owner.getByLabel("Project role").selectOption("viewer");
  await owner.getByRole("button", { name: "Create invitation" }).click();
  const link = await owner.getByLabel("Invitation link").inputValue();
  expect(link).toContain("/invite/");

  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await viewer.goto(link);
  await expect(viewer.getByRole("heading", { name: "Join Acme Builders" })).toBeVisible();
  await viewer.getByLabel("Your name").fill("Val Viewer");
  await viewer.getByLabel("Choose a password").fill("another long password");
  await viewer.getByRole("button", { name: "Accept invitation" }).click();
  await expect(viewer.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await viewer.getByRole("link", { name: "Projects" }).click();
  await expect(viewer.getByRole("button", { name: "New project" })).toHaveCount(0);
  await viewer.getByRole("link", { name: "Harbor Tower" }).click();
  await expect(viewer.getByText("your role: viewer")).toBeVisible();
  await expect(viewer.getByLabel("Task title")).toHaveCount(0);
  await expect(viewer.getByRole("tab", { name: "Settings" })).toHaveCount(0);
  await expect(viewer.getByRole("link", { name: "Audit log" })).toHaveCount(0);

  // The audit log shows the trail to the owner
  await owner.getByRole("link", { name: "Audit log" }).click();
  await expect(owner.getByRole("cell", { name: "invitation.accept" })).toBeVisible();

  // Sign out / back in
  await owner.getByRole("button", { name: "Sign out" }).click();
  await owner.getByLabel("Email").fill("olive@acme.test");
  await owner.getByLabel("Password").fill("correct horse battery");
  await owner.getByRole("button", { name: "Sign in" }).click();
  await expect(owner.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});
