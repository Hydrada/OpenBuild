import { expect, test } from "@playwright/test";
import { api, openProject, world } from "./helpers";

/** Keyboard-only use: what a sighted keyboard user and a screen-reader user both depend on. */
test("keyboard: skip link, visible focus, forms open into their first field and return focus", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await owner.goto(`/projects/${w.projectId}/rfis`);
  await expect(owner.getByRole("heading", { level: 1, name: /Harbor Tower/ })).toBeVisible();

  // The first Tab reaches the skip link, and following it puts focus on the main content.
  await owner.keyboard.press("Tab");
  await expect(owner.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await owner.keyboard.press("Enter");
  await expect(owner.locator("#main")).toBeFocused();

  // Focus is visible on controls reached by keyboard.
  const newRfi = owner.getByRole("button", { name: "New RFI" });
  await newRfi.focus();
  await owner.keyboard.press("Shift+Tab");
  await owner.keyboard.press("Tab");
  await expect(newRfi).toBeFocused();
  const outline = await newRfi.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");

  // Opening a form moves focus into it; Escape closes it and focus returns to the button.
  await owner.keyboard.press("Enter");
  await expect(owner.getByLabel("Subject")).toBeFocused();
  await owner.keyboard.press("Escape");
  await expect(owner.getByLabel("Subject")).toHaveCount(0);
  await expect(newRfi).toBeFocused();

  // A whole record created without the mouse.
  await owner.keyboard.press("Enter");
  await owner.keyboard.type("Beam depth at grid C");
  await owner.getByLabel("Question").focus();
  await owner.keyboard.type("W18 or W21?");
  await owner.getByRole("button", { name: "Create RFI" }).focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("link", { name: /Beam depth at grid C|^1$/ }).first()).toBeVisible();
});

test("keyboard: inline confirmations take focus, Escape cancels, and focus goes back", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await api(owner).post(`/projects/${w.projectId}/cost-codes`, { code: "01", description: "GC" });
  const e = await api(owner).post(`/projects/${w.projectId}/estimates`, { name: "GMP" });
  await owner.goto(`/estimates/${e.id}`);
  const send = owner.getByRole("button", { name: "Send to budget" });
  await send.focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("button", { name: "Confirm" })).toBeFocused();
  await owner.keyboard.press("Escape");
  await expect(owner.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await expect(send).toBeFocused();
  await openProject(owner, w, "Estimating");
});
