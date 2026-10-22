// Real-GUI acceptance run through CUA Driver against a running OpenBuild server.
// Usage: node e2e/cua/gui-flow.mjs <baseUrl> <phase: setup|after-restart> <outDir>
// Drives a driver-owned isolated Chromium profile (never a personal profile).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "./mcp.mjs";

const [base = "http://127.0.0.1:3200", phase = "setup", outDir = "gui-evidence"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const S = "openbuild-gui";
const OWNER = { email: "gui-owner@acme.test", password: "correct horse battery" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

const c = await connect();
const prep = (await c.call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" }, session: S })).json;
await sleep(2500);
const win = (await c.call("list_windows", { pid: prep.prepared_pid })).json.windows[0];
const bind = (await c.call("get_browser_state", { pid: prep.prepared_pid, window_id: win.window_id, session: S })).json;
const T = { session: S, target_id: bind.target_id, tab_id: bind.tabs[0].tab_id };

let snap;
async function look(shot) {
  await sleep(700);
  const r = await c.call("get_browser_state", { ...T, snapshot_format: "semantic_v2", include_screenshot: !!shot });
  snap = r.json;
  if (shot && r.images[0]) writeFileSync(join(outDir, `${shot}.png`), Buffer.from(r.images[0].data, "base64"));
  return snap;
}
function ref(role, name) {
  const hit = snap.refs.find((r) => (!role || r.role === role) && (name instanceof RegExp ? name.test(r.name ?? "") : r.name === name));
  if (!hit) throw new Error(`No ${role} "${name}" on ${snap.page.url}\n${snap.outline.slice(0, 1500)}`);
  return hit.ref;
}
const has = (text) => snap.outline.includes(text);
const go = async (path) => { await c.call("browser_navigate", { ...T, url: base + path }); await look(); for (let i = 0; i < 5 && has("Loading"); i++) await look(); };
const click = async (role, name) => { await c.call("browser_click", { ...T, ref: ref(role, name) }); await look(); };
/** Click, and if the page has not reached `expect` yet (e.g. clicked during hydration), wait and retry. */
async function clickUntil(role, name, expect, tries = 3) {
  for (let i = 0; i < tries; i++) {
    if (i === 0 || snap.refs.some((r) => r.role === role && r.name === name)) await click(role, name);
    for (let w = 0; w < 4 && !has(expect); w++) await look();
    if (has(expect)) return;
  }
  throw new Error(`Clicking ${role} "${name}" never produced "${expect}"`);
}
const type = async (role, name, text, mode = "insert_text") => { await c.call("browser_type", { ...T, ref: ref(role, name), text, replace: false, mode }); };
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

try {
  if (phase === "setup") {
    await go("/");
    await clickUntil("button", "New here? Create an organization", 'textbox "Your name"');
    await type("textbox", "Your name", "Gina GUI");
    await type("textbox", "Company name", "GUI Builders");
    await type("textbox", "Email", OWNER.email);
    await type("textbox", "Password", OWNER.password);
    await clickUntil("button", "Create account", 'heading "Dashboard"');
    await look("01-dashboard");
    check("register organization → dashboard", has('heading "Dashboard"'));

    await clickUntil("link", "Projects", 'button "New project"');
    await clickUntil("button", "New project", 'textbox "Project name"');
    await type("textbox", "Project name", "Riverside Library");
    await type("textbox", "Project number", "RL-7");
    await type("textbox", "Address", "12 River Rd");
    await clickUntil("button", "Create project", "your role:");
    await look("02-project");
    check("create project", has("Riverside Library") && has("your role:"));

    await type("textbox", "Task title", "Submit steel shop drawings");
    await click("button", "Add task");
    await look("03-task");
    check("add task", has("Submit steel shop drawings"));

    // Interrupted workflow: start a project, abandon it mid-form.
    await click("link", "Projects");
    await click("button", "New project");
    await type("textbox", "Project name", "ABANDONED DRAFT");
    await go("/");
    await go("/projects");
    check("abandoned form creates nothing", !has("ABANDONED DRAFT") && has("Riverside Library"));

    // Validation: server rejects end-before-start even though the browser allows it.
    await click("button", "New project");
    await type("textbox", "Project name", "Bad dates");
    await type(null, "Start date", "06012026", "keystrokes");
    await type(null, "Finish date", "01012026", "keystrokes");
    await click("button", "Create project");
    await look("04-validation");
    check("server-side date validation shown", has("End date is before start date"), snap.outline.includes("Bad dates") && !has("End date") ? "dates not entered" : "");

    // Invite a member with no project access
    await click("link", "Team");
    await type("textbox", "Email", "gui-member@acme.test");
    await click("button", "Create invitation");
    const link = snap.refs.find((r) => r.name === "Invitation link")?.value;
    await look("05-invite");
    check("invitation link generated", /\/invite\//.test(link ?? ""), link);

    await click("button", "Sign out");
    check("sign out", has('button "Sign in"'));

    await c.call("browser_navigate", { ...T, url: link });
    await look();
    await type("textbox", "Your name", "Max Member");
    await type("textbox", "Choose a password", "another long password");
    await click("button", "Accept invitation");
    await look("06-member-dashboard");
    check("member joins via invite", has('heading "Dashboard"'));
    check("member has no Audit log link", !has('link "Audit log"'));
    await click("link", "Projects");
    check("member cannot see unassigned project", !has("Riverside Library"));
    check("member has no New project button", !has('button "New project"'));
    await click("button", "Sign out");
  } else {
    // After a server restart: data and login must persist.
    await go("/");
    await type("textbox", "Email", OWNER.email);
    await type("textbox", "Password", OWNER.password);
    await click("button", "Sign in");
    await click("link", "Projects");
    await click("link", "Riverside Library");
    await look("07-after-restart");
    check("project persists after restart", has("Riverside Library"));
    check("task persists after restart", has("Submit steel shop drawings"));
    await click("link", "Audit log");
    await look("08-audit");
    check("audit trail recorded", has("invitation.accept") && has("project.create") && has("task.create"));
  }
} catch (e) {
  check("flow completed without error", false, e.message.slice(0, 600));
  try { await look(`error-${phase}`); } catch {}
} finally {
  writeFileSync(join(outDir, `results-${phase}.json`), JSON.stringify(results, null, 2));
  c.close();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
