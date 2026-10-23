import { expect, test } from "@playwright/test";
import { api, jpeg, member, openProject, tool, world } from "./helpers";

test("daily log with manpower, then signed and locked", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Daily log");
  await owner.getByRole("button", { name: "New daily log" }).click();
  await owner.getByLabel("Date").fill("2026-10-20");
  await owner.getByLabel("Weather").fill("Rain, 10 mph wind");
  await owner.getByLabel("Low °F").fill("41");
  await owner.getByLabel("High °F").fill("55.5");
  await owner.getByLabel("Work performed").fill("Formed L2 deck east half");
  await owner.getByRole("button", { name: "Create log" }).click();
  await owner.getByRole("link", { name: /2026|10\/20/ }).first().click();
  await expect(owner.getByRole("heading", { name: /Daily log/ })).toBeVisible();

  await owner.getByRole("button", { name: "Add company" }).click();
  await owner.getByLabel("Company row 1").fill("Acme Concrete");
  await owner.getByLabel("Workers row 1").fill("8");
  await owner.getByLabel("Hours row 1").fill("63.75");
  await owner.getByRole("button", { name: "Add company" }).click();
  await owner.getByLabel("Company row 2").fill("Spark Electric");
  await owner.getByLabel("Workers row 2").fill("3");
  await owner.getByLabel("Hours row 2").fill("24.1");
  await owner.getByRole("button", { name: "Save manpower" }).click();
  await expect(owner.getByText("11 workers")).toBeVisible();

  await owner.getByRole("button", { name: "Sign log" }).click();
  await owner.getByRole("button", { name: "Confirm" }).click();
  await expect(owner.getByText(/Signed by Olive Owner/)).toBeVisible();
  await expect(owner.getByRole("button", { name: "Save log" })).toHaveCount(0);

  await owner.getByRole("link", { name: "← Daily log" }).click();
  await expect(owner.getByRole("cell", { name: "87.85" })).toBeVisible();
});

test("inspection failure becomes a punch item that the sub fixes with a photo", async ({ browser }) => {
  const w = await world(browser);
  const sub = await member(browser, w, "Sam Sub", "subcontractor", { company: "Acme Concrete" });
  const { owner } = w;
  await owner.goto("/settings");
  await owner.getByLabel("Template name").fill("Pre-pour checklist");
  await owner.getByLabel("Checklist items (one per line)").fill("Rebar spacing per plan\nEmbeds installed\nFormwork braced");
  await owner.getByRole("button", { name: "Create template" }).click();
  await expect(owner.getByText("Pre-pour checklist")).toBeVisible();

  await openProject(owner, w, "Inspections");
  await owner.getByRole("button", { name: "New inspection" }).click();
  await owner.getByLabel("Title").fill("L2 deck pre-pour");
  await owner.getByLabel("Location").fill("Level 2");
  await owner.getByLabel("Checklist template").selectOption({ label: "Pre-pour checklist (3 items)" });
  await owner.getByRole("button", { name: "Start inspection" }).click();
  await owner.getByRole("link", { name: "L2 deck pre-pour" }).click();

  await owner.getByRole("group", { name: "Result for Rebar spacing per plan" }).getByRole("button", { name: "Pass" }).click();
  await owner.getByRole("group", { name: "Result for Embeds installed" }).getByRole("button", { name: "Fail" }).click();
  await owner.getByRole("button", { name: "Create punch item" }).click();
  await owner.getByLabel("Deficiency note").fill("Missing 4 plates at grid C");
  await owner.getByLabel("Assign to").selectOption({ label: "Sam Sub (Acme Concrete)" });
  await owner.getByRole("button", { name: "Create punch item" }).click();
  await expect(owner.getByRole("link", { name: "Punch item #1" })).toBeVisible();
  await owner.getByRole("button", { name: "Complete inspection" }).click();
  await expect(owner.getByText("item(s) still need a result")).toBeVisible();
  await owner.getByRole("group", { name: "Result for Formwork braced" }).getByRole("button", { name: "N/A" }).click();
  await owner.getByRole("button", { name: "Complete inspection" }).click();
  await expect(owner.getByRole("heading", { name: /Completed/ })).toBeVisible();

  // Subcontractor: limited tools, fixes the item
  const s = sub.page;
  await s.goto(`/projects/${w.projectId}`);
  const nav = s.getByRole("navigation", { name: "Project tools" });
  await expect(nav.getByRole("link", { name: "Budget" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Daily log" })).toHaveCount(0);
  await nav.getByRole("link", { name: "Punch list" }).click();
  await s.getByRole("link", { name: "1", exact: true }).click();
  await s.getByLabel("Add photos").setInputFiles(jpeg("plates-installed"));
  await expect(s.getByRole("link", { name: "plates-installed.jpg" })).toBeVisible();
  await s.getByRole("button", { name: "Mark ready for review" }).click();
  await expect(s.getByRole("heading", { name: /Ready for review/ })).toBeVisible();
  await expect(s.getByRole("button", { name: "Verify & close" })).toHaveCount(0);

  await owner.goto(s.url());
  await owner.getByRole("button", { name: "Verify & close" }).click();
  await expect(owner.getByRole("heading", { name: /Closed/ })).toBeVisible();
});

test("observations and incidents", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Observations");
  await owner.getByRole("button", { name: "New observation" }).click();
  await owner.getByLabel("Title").fill("Unguarded floor opening");
  await owner.getByLabel("Severity").selectOption("high");
  await owner.getByRole("button", { name: "Record observation" }).click();
  await owner.getByRole("link", { name: "Unguarded floor opening" }).click();
  await owner.getByLabel("How it was resolved").fill("Covered with plywood and labeled");
  await owner.getByRole("button", { name: "Close observation" }).click();
  await expect(owner.getByText("Covered with plywood and labeled")).toBeVisible();

  await openProject(owner, w, "Incidents");
  await owner.getByRole("button", { name: "Report incident" }).click();
  await owner.getByLabel("Title").fill("Hand laceration");
  await owner.getByLabel("Type").selectOption("injury");
  await owner.getByLabel("What happened").fill("Cut while handling sheet metal");
  await owner.getByLabel("OSHA recordable").check();
  await owner.getByRole("button", { name: "Submit report" }).click();
  await owner.getByRole("link", { name: "Hand laceration" }).click();
  await owner.getByLabel("Status").selectOption("closed");
  await owner.getByRole("button", { name: "Save investigation" }).click();
  await expect(owner.getByText("Record the corrective action before closing")).toBeVisible();
  await owner.getByLabel("Corrective action").fill("Cut-resistant gloves required");
  await owner.getByRole("button", { name: "Save investigation" }).click();
  await expect(owner.getByRole("heading", { name: /Hand laceration Closed/ })).toBeVisible();
});

test("offline punch item is queued, then synced exactly once on reconnect", async ({ browser }) => {
  const w = await world(browser);
  const { owner, ownerCtx } = w;
  await openProject(owner, w, "Punch list");
  await ownerCtx.setOffline(true);
  await owner.getByRole("button", { name: "New punch item" }).click();
  await owner.getByLabel("Title").fill("Patch drywall at 104");
  await owner.getByRole("button", { name: "Create item" }).click();
  await expect(owner.getByText(/You are offline — saved on this device/)).toBeVisible();
  await expect(owner.getByRole("link", { name: /Offline · 1 queued/ })).toBeVisible();

  await ownerCtx.setOffline(false);
  await expect(owner.getByRole("link", { name: /queued|waiting to sync/ })).toHaveCount(0, { timeout: 15_000 });
  const items = await api(owner).get(`/projects/${w.projectId}/punch-items`);
  expect(items.map((p: { title: string }) => p.title)).toEqual(["Patch drywall at 104"]);
  await expect(owner.getByRole("cell", { name: "Patch drywall at 104" })).toHaveCount(1);
});

test("photo library", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Photos");
  await owner.getByLabel("Upload photos").setInputFiles([jpeg("north-elevation"), jpeg("south-elevation")]);
  await expect(owner.getByText("north-elevation.jpg")).toBeVisible();
  await expect(owner.getByText("south-elevation.jpg")).toBeVisible();
});

test("offline edits: inspection results and punch status replay on reconnect", async ({ browser }) => {
  const w = await world(browser);
  const { owner, ownerCtx } = w;
  const ins = await api(owner).post(`/projects/${w.projectId}/inspections`, { title: "Offline walk", items: ["Exit signs lit", "Extinguishers tagged"] });
  const punch = await api(owner).post(`/projects/${w.projectId}/punch-items`, { title: "Replace ceiling tile" });
  await owner.goto(`/inspections/${ins.id}`);
  await expect(owner.getByRole("heading", { name: /Offline walk/ })).toBeVisible();
  await ownerCtx.setOffline(true);
  await owner.getByRole("group", { name: "Result for Exit signs lit" }).getByRole("button", { name: "Pass" }).click();
  await owner.getByRole("group", { name: "Result for Extinguishers tagged" }).getByRole("button", { name: "N/A" }).click();
  await expect(owner.getByText(/You are offline — saved on this device/)).toBeVisible();
  await expect(owner.getByRole("heading", { name: /Offline walk/ })).toBeVisible(); // screen stays usable offline
  await ownerCtx.setOffline(false);
  await expect(owner.getByRole("link", { name: /queued|waiting to sync/ })).toHaveCount(0, { timeout: 15_000 });
  const after = await api(owner).get(`/inspections/${ins.id}`);
  expect(after.items.map((i: { result: string }) => i.result)).toEqual(["pass", "na"]);

  await owner.goto(`/punch/${punch.id}`);
  await expect(owner.getByRole("button", { name: "Mark ready for review" })).toBeVisible();
  await ownerCtx.setOffline(true);
  await owner.getByRole("button", { name: "Mark ready for review" }).click();
  await expect(owner.getByText(/You are offline/)).toBeVisible();
  await ownerCtx.setOffline(false);
  await expect.poll(async () => (await api(owner).get(`/punch-items/${punch.id}`)).status, { timeout: 15_000 }).toBe("ready_for_review");
});

test("offline photo is kept on the device and attached on reconnect", async ({ browser }) => {
  const w = await world(browser);
  const { owner, ownerCtx } = w;
  const punch = await api(owner).post(`/projects/${w.projectId}/punch-items`, { title: "Cracked tile at lobby" });
  await owner.goto(`/punch/${punch.id}`);
  await expect(owner.getByRole("heading", { name: /Cracked tile/ })).toBeVisible();
  await ownerCtx.setOffline(true);
  await owner.getByLabel("Add photos").setInputFiles(jpeg("cracked-tile"));
  await expect(owner.getByText(/1 photo\(s\) saved on this device/)).toBeVisible();
  await expect(owner.getByRole("link", { name: /Offline · 1 queued/ })).toBeVisible();
  await ownerCtx.setOffline(false);
  await expect.poll(async () => (await api(owner).get(`/punch-items/${punch.id}`)).photos.map((p: { name: string }) => p.name), { timeout: 15_000 }).toEqual(["cracked-tile.jpg"]);
  await expect(owner.getByRole("link", { name: "cracked-tile.jpg" })).toBeVisible();
});
