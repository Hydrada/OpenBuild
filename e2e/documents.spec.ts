import { expect, test } from "@playwright/test";
import { member, openProject, pdf, tool, world } from "./helpers";

test("drawings: upload, revise, view history and upload a markup", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Drawings");
  await owner.getByRole("button", { name: "Upload sheet" }).click();
  await owner.getByLabel("Sheet number").fill("A-101");
  await owner.getByLabel("Sheet title (new sheets)").fill("Ground floor plan");
  await owner.getByLabel("Discipline").fill("Architectural");
  await owner.getByLabel("Revision").fill("0");
  await owner.getByLabel("PDF").setInputFiles(pdf("A-101 r0"));
  await owner.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(owner.getByRole("cell", { name: "Ground floor plan" })).toBeVisible();

  await owner.getByRole("button", { name: "Upload sheet" }).click();
  await owner.getByLabel("Sheet number").fill("A-101");
  await owner.getByLabel("Revision").fill("1");
  await owner.getByLabel("PDF").setInputFiles(pdf("A-101 r1"));
  await owner.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(owner.getByRole("row", { name: /A-101/ }).getByRole("cell", { name: "2", exact: true })).toBeVisible();

  await owner.getByRole("link", { name: "A-101" }).click();
  await expect(owner.getByRole("heading", { name: "A-101 — Ground floor plan" })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Rev 1" })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Rev 0" })).toBeVisible();

  await owner.getByRole("button", { name: "Open in OpenDraft" }).click();
  await expect(owner.getByRole("link", { name: "Download the sheet" })).toBeVisible();
  await owner.getByLabel("Marked-up PDF").setInputFiles(pdf("markup"));
  await owner.getByLabel("Note").fill("Clouded door swing");
  await owner.getByRole("button", { name: "Upload markup" }).click();
  await expect(owner.getByText("Clouded door swing")).toBeVisible();
});

test("RFIs: create against a sheet, answer officially as the assignee, close", async ({ browser }) => {
  const w = await world(browser);
  const arch = await member(browser, w, "Ari Architect", "viewer");
  const { owner } = w;
  await owner.request.post(`/api/projects/${w.projectId}/drawings`, {
    headers: { "x-openbuild-csrf": "1" },
    multipart: { number: "S-201", title: "Framing plan", revision: "0", file: pdf("S-201") },
  });

  await openProject(owner, w, "RFIs");
  await owner.getByRole("button", { name: "New RFI" }).click();
  await owner.getByLabel("Subject").fill("Beam depth at grid C");
  await owner.getByLabel("Question").fill("Plans show W18, schedule shows W21. Which governs?");
  await owner.getByLabel("Ball in court").selectOption({ label: "Ari Architect" });
  await owner.getByLabel("Drawing").selectOption({ label: "S-201 Framing plan" });
  await owner.getByLabel("Cost impact").selectOption("yes");
  await owner.getByRole("button", { name: "Create RFI" }).click();
  await expect(owner.getByRole("cell", { name: "Beam depth at grid C" })).toBeVisible();

  const a = arch.page;
  await a.goto("/notifications");
  await a.getByRole("link", { name: /RFI #1 needs your answer/ }).click();
  await expect(a.getByRole("heading", { name: /RFI #1: Beam depth at grid C/ })).toBeVisible();
  await a.getByLabel("Response", { exact: true }).fill("W21x44 governs. Schedule is correct.");
  await a.getByLabel("This is the official answer").check();
  await a.getByRole("button", { name: "Post response" }).click();
  await expect(a.getByText("Official answer")).toBeVisible();
  await expect(a.getByRole("button", { name: "Close RFI" })).toHaveCount(0); // viewers cannot close

  await owner.reload();
  await owner.getByRole("link", { name: "1", exact: true }).click();
  await expect(owner.getByText("Answered", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Close RFI" }).click();
  await expect(owner.getByRole("button", { name: "Reopen" })).toBeVisible();
});

test("submittals: route to two reviewers, revise and resubmit, approve as noted", async ({ browser }) => {
  const w = await world(browser);
  const arch = await member(browser, w, "Ari Architect", "viewer");
  const eng = await member(browser, w, "Eli Engineer", "viewer");
  const { owner } = w;
  await openProject(owner, w, "Specifications");
  await owner.getByRole("button", { name: "Add section" }).click();
  await owner.getByLabel("Section number").fill("05 12 00");
  await owner.getByLabel("Title").fill("Structural steel framing");
  await owner.getByRole("button", { name: "Add section", exact: true }).click();
  await expect(owner.getByRole("cell", { name: "Structural steel framing" })).toBeVisible();

  await tool(owner, "Submittals").click();
  await owner.getByRole("button", { name: "New submittal" }).click();
  await owner.getByLabel("Title").fill("Steel shop drawings");
  await owner.getByLabel("Spec section").selectOption({ label: "05 12 00 Structural steel framing" });
  await owner.getByLabel("First reviewer").selectOption({ label: "Ari Architect" });
  await owner.getByLabel("Second reviewer").selectOption({ label: "Eli Engineer" });
  await owner.getByRole("button", { name: "Create submittal" }).click();
  await owner.getByRole("link", { name: "1", exact: true }).click();
  await owner.getByRole("button", { name: "Submit for review" }).click();
  await expect(owner.getByText("In review").first()).toBeVisible();
  const url = owner.url();

  await arch.page.goto(url);
  await arch.page.getByLabel("Comment (optional)").fill("Add connection details");
  await arch.page.getByRole("button", { name: "Revise & resubmit" }).click();
  await expect(arch.page.getByText("Revise & resubmit").first()).toBeVisible();

  await owner.reload();
  await owner.getByRole("button", { name: "Create revision 1" }).click();
  await expect(owner.getByRole("heading", { name: /rev 1/ })).toBeVisible();
  await owner.getByRole("button", { name: "Submit for review" }).click();
  const rev1 = owner.url();

  await arch.page.goto(rev1);
  await arch.page.getByRole("button", { name: "Approved as noted" }).click();
  await eng.page.goto(rev1);
  await eng.page.getByRole("button", { name: "Approved", exact: true }).click();
  await owner.reload();
  await expect(owner.getByRole("heading", { name: /Approved as noted/ })).toBeVisible();
});

test("documents: folder, versions and approval", async ({ browser }) => {
  const w = await world(browser);
  const pm = await member(browser, w, "Pat Manager", "manager");
  const { owner } = w;
  await openProject(owner, w, "Documents");
  await owner.getByRole("button", { name: "New folder" }).click();
  await owner.getByLabel("Folder name").fill("Logistics");
  await owner.getByRole("button", { name: "Create folder" }).click();
  await owner.getByRole("button", { name: /Logistics/ }).click();
  await owner.getByRole("button", { name: "Upload document" }).click();
  await owner.getByLabel("File", { exact: true }).setInputFiles(pdf("site-plan"));
  await owner.getByLabel("Name (optional)").fill("Site logistics plan");
  await owner.getByRole("button", { name: "Upload", exact: true }).click();
  await owner.getByRole("link", { name: "Site logistics plan" }).click();
  await owner.getByLabel("New version", { exact: true }).setInputFiles(pdf("site-plan-v2"));
  await owner.getByLabel("What changed").fill("Moved crane");
  await owner.getByRole("button", { name: "Upload new version" }).click();
  await expect(owner.getByText("Version 2")).toBeVisible();
  await owner.getByLabel("First approver").selectOption({ label: "Pat Manager" });
  await owner.getByRole("button", { name: "Submit for approval" }).click();
  await pm.page.goto(owner.url());
  await pm.page.getByRole("button", { name: "Approved", exact: true }).click();
  await owner.reload();
  await expect(owner.getByRole("heading", { name: /Site logistics plan Approved/ })).toBeVisible();
});
