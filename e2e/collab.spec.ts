import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { api, member, openProject, world } from "./helpers";

test("mentions notify, custom fields appear, API keys are shown once", async ({ browser }) => {
  const w = await world(browser);
  const pm = await member(browser, w, "Pat Manager", "manager");
  const { owner } = w;

  await owner.goto("/settings");
  await owner.getByLabel("Applies to").selectOption("rfi");
  await owner.getByLabel("Label", { exact: true }).fill("Discipline");
  await owner.getByLabel("Key (lowercase_with_underscores)").fill("discipline");
  await owner.getByLabel("Type", { exact: true }).selectOption("select");
  await owner.getByLabel("Options for select (comma separated)").fill("Arch, Struct, MEP");
  await owner.getByRole("button", { name: "Add field" }).click();
  await expect(owner.getByRole("cell", { name: "Discipline", exact: true })).toBeVisible();

  await owner.getByLabel("Key name").fill("Reporting");
  await owner.getByRole("button", { name: "Create key" }).click();
  const secret = await owner.getByLabel("New API key").inputValue();
  expect(secret).toMatch(/^ob_/);
  const r = await owner.request.get(`/api/orgs/${w.orgId}/projects`, { headers: { authorization: `Bearer ${secret}`, cookie: "" } });
  expect(r.status()).toBe(200);

  const rfi = await api(owner).post(`/projects/${w.projectId}/rfis`, { subject: "Slab edge", question: "Confirm dimension" });
  await owner.goto(`/rfis/${rfi.id}`);
  await owner.getByLabel("Discipline").selectOption("Struct");
  await owner.getByRole("button", { name: "Save fields" }).click();
  await owner.getByLabel("Add a comment").fill("Pat, can you check this?");
  await owner.getByLabel("Notify (mention)").selectOption({ label: "Pat Manager" });
  await owner.getByRole("button", { name: "Post comment" }).click();
  await expect(owner.getByText("Pat, can you check this?")).toBeVisible();

  const p = pm.page;
  await p.goto("/");
  await expect(p.getByRole("link", { name: /Notifications/ })).toContainText("1");
  await p.getByRole("link", { name: /Notifications/ }).click();
  await p.getByRole("link", { name: /mentioned you on a rfi/ }).click();
  await expect(p.getByRole("heading", { name: /Slab edge/ })).toBeVisible();
  await expect(p.getByLabel("Discipline")).toHaveValue("Struct");
});

test("password reset link and account security", async ({ browser }) => {
  const w = await world(browser);
  const m = await member(browser, w, "Mo Member", "contributor");
  const { owner } = w;
  await owner.goto("/team");
  await owner.getByRole("row", { name: /Mo Member/ }).getByRole("button", { name: "Reset password" }).click();
  const link = await owner.getByLabel("Reset link").inputValue();
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(link);
  await anon.getByLabel(/New password for/).fill("a brand new password");
  await anon.getByRole("button", { name: "Set password" }).click();
  await expect(anon.getByText("Password updated.")).toBeVisible();
  await m.page.goto("/");
  await expect(m.page.getByRole("button", { name: "Sign in" })).toBeVisible(); // old session revoked

  await owner.goto("/account");
  await owner.getByLabel("Current password").fill("correct horse battery");
  await owner.getByLabel("New password (10+ characters)").fill("another strong password");
  await owner.getByRole("button", { name: "Change password" }).click();
  await expect(owner.getByText("Password changed.")).toBeVisible();
});

test("key screens have no serious accessibility violations", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await api(owner).post(`/projects/${w.projectId}/rfis`, { subject: "a11y", question: "q" });
  const plan = await api(owner).post(`/projects/${w.projectId}/action-plans`, { title: "Closeout", kind: "closeout", useCloseoutTemplate: true });
  const tm = await api(owner).post(`/projects/${w.projectId}/tm-tickets`, { workDate: "2026-10-05", description: "Extra work", lines: [{ category: "labor", description: "Carpenter", quantity: "2", rate: "80" }] });
  const extra = ["correspondence", "direct-costs", "tm-tickets", "equipment", "action-plans", "warranties", "coordination-issues", "lookahead"].map((t) => `/projects/${w.projectId}/${t}`).concat("/reports");
  const pages = [...extra, `/action-plans/${plan.id}`, `/tm-tickets/${tm.id}`, "/", "/projects", "/team", "/settings", "/my-work", "/account", `/projects/${w.projectId}`, `/projects/${w.projectId}/rfis`, `/projects/${w.projectId}/punch`, `/projects/${w.projectId}/budget`, `/projects/${w.projectId}/schedule`, `/projects/${w.projectId}/meetings`, `/projects/${w.projectId}/timesheets`, `/projects/${w.projectId}/bidding`, `/projects/${w.projectId}/models`];
  const failures: string[] = [];
  for (const path of pages) {
    await owner.goto(path);
    await owner.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page: owner }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    for (const v of results.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
      failures.push(`${path}: ${v.id} (${v.impact}) — ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")}`);
    }
  }
  const anon = await (await browser.newContext()).newPage();
  await anon.goto("/");
  const login = await new AxeBuilder({ page: anon }).withTags(["wcag2a", "wcag2aa"]).analyze();
  failures.push(...login.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((v) => `login: ${v.id}`));
  expect(failures).toEqual([]);
});

test("subcontractor sees only their work", async ({ browser }) => {
  const w = await world(browser);
  const sub = await member(browser, w, "Sam Sub", "subcontractor", { company: "Spark Electric" });
  await api(w.owner).post(`/projects/${w.projectId}/rfis`, { subject: "Panel location", question: "?", assigneeId: sub.id });
  await api(w.owner).post(`/projects/${w.projectId}/rfis`, { subject: "Owner budget question", question: "internal" });
  await openProject(sub.page, w, "RFIs");
  await expect(sub.page.getByRole("cell", { name: "Panel location" })).toBeVisible();
  await expect(sub.page.getByRole("cell", { name: "Owner budget question" })).toHaveCount(0);
  await sub.page.goto("/my-work");
  await expect(sub.page.getByRole("link", { name: /RFI #1: Panel location/ })).toBeVisible();
});
