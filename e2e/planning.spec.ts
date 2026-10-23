import { expect, test } from "@playwright/test";
import { api, openProject, world } from "./helpers";

test("project search finds records across tools and opens them", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  await api(owner).post(`/projects/${w.projectId}/rfis`, { subject: "Embed plate at grid C", question: "Size?" });
  await api(owner).post(`/projects/${w.projectId}/punch-items`, { title: "Grout embed plate base" });
  await openProject(owner, w);
  await owner.getByRole("searchbox", { name: "Search this project" }).fill("embed plate");
  await owner.getByRole("button", { name: "Search" }).click();
  const results = owner.getByRole("region", { name: "Search results" });
  await expect(results.getByRole("row")).toHaveCount(3); // header + 2
  await results.getByRole("link", { name: /Embed plate at grid C/ }).click();
  await expect(owner.getByRole("heading", { name: /Embed plate at grid C/ })).toBeVisible();
});

test("lookahead: add a task under an activity, block it with a reason", async ({ browser }) => {
  const w = await world(browser);
  const { owner } = w;
  const monday = new Date();
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const iso = (d: Date) => d.toLocaleDateString("en-CA");
  const wed = new Date(monday); wed.setDate(monday.getDate() + 2);
  const fri = new Date(monday); fri.setDate(monday.getDate() + 11);
  await api(owner).post(`/projects/${w.projectId}/schedule`, { name: "Pour level 3", startDate: iso(wed), endDate: iso(fri) });
  await openProject(owner, w, "Lookahead");
  await expect(owner.getByRole("rowheader", { name: /Pour level 3/ })).toBeVisible();
  await owner.getByRole("button", { name: "Add lookahead task" }).click();
  await owner.getByLabel("Task", { exact: true }).fill("Form deck bay 3");
  await owner.getByLabel("Under activity").selectOption({ label: "Pour level 3" });
  await owner.getByLabel("Start", { exact: true }).fill(iso(wed));
  await owner.getByLabel("Finish", { exact: true }).fill(iso(wed));
  await owner.getByLabel("Crew size").fill("6");
  await owner.getByRole("button", { name: "Add task" }).click();
  await expect(owner.getByRole("row", { name: /Form deck bay 3/ })).toContainText("6 crew");
  await expect(owner.getByRole("cell", { name: `Form deck bay 3 on ${iso(wed)}` })).toBeVisible();

  await owner.getByLabel("Status of Form deck bay 3").selectOption("blocked");
  await owner.getByLabel("What is blocking Form deck bay 3").fill("Deck delivery late");
  await owner.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Blocked: Deck delivery late")).toBeVisible();
});
