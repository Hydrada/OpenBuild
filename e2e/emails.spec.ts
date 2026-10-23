import { expect, test } from "@playwright/test";
import { openProject, world } from "./helpers";

test("emails: send from the project (logged without a mail server), receive a reply into the thread", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await openProject(owner, w, "Emails");
  await owner.getByRole("button", { name: "New email" }).click();
  await owner.getByLabel("To (comma separated)").fill("architect@example.com");
  await owner.getByLabel("Subject").fill("Door hardware question");
  await owner.getByLabel("Message").fill("Lever or knob?");
  await owner.getByRole("button", { name: "Send" }).click();
  await expect(owner.getByText("No mail server is configured, so the email was saved to the log only.")).toBeVisible();
  await owner.getByRole("button", { name: "Set up inbound email" }).click();
  const url = await owner.getByLabel("Inbound email URL").inputValue();
  const res = await owner.request.post(url, { data: { from: "architect@example.com", subject: "RE: Door hardware question [#E-1]", text: "Lever sets." } });
  expect(res.status()).toBe(202);
  await owner.reload();
  await owner.getByRole("button", { name: "Door hardware question [#E-1]" }).click();
  const thread = owner.getByRole("region", { name: "Email thread" });
  await expect(thread).toContainText("Lever or knob?");
  await expect(thread).toContainText("Lever sets.");
});
