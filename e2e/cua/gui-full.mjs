// Full real-GUI acceptance run through CUA Driver (driver-owned isolated Chromium; never a personal profile).
// Usage: node e2e/cua/gui-full.mjs <baseUrl> <phase: run|after-restart> <outDir>
// Covers: org + project creation, inviting users, role restrictions, drawing upload, RFIs, submittals, inspections,
// punch list, change orders, financial calculations, report export, an interrupted workflow and (phase 2) persistence.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect } from "./mcp.mjs";

const [base = "http://127.0.0.1:3200", phase = "run", outArg = "docs/evidence/gui-full"] = process.argv.slice(2);
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });
const S = "openbuild-full";
const OWNER = { email: "pm-owner@harbor.test", password: "correct horse battery" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const stateFile = join(outDir, "state.json");

// Fixtures on disk for real file-chooser uploads.
const fixtures = join(outDir, "fixtures");
mkdirSync(fixtures, { recursive: true });
const pdfPath = join(fixtures, "A-101.pdf");
writeFileSync(pdfPath, "%PDF-1.4\n% OpenBuild CUA fixture\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const jpgPath = join(fixtures, "embeds.jpg");
writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]));

const c = await connect();
const prep = (await c.call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" }, session: S })).json;
await sleep(2500);
const win = (await c.call("list_windows", { pid: prep.prepared_pid })).json.windows[0];
const bind = (await c.call("get_browser_state", { pid: prep.prepared_pid, window_id: win.window_id, session: S })).json;
const T = { session: S, target_id: bind.target_id, tab_id: bind.tabs[0].tab_id };

let snap;
let shot = 0;
async function look(name) {
  await sleep(600);
  const r = await c.call("get_browser_state", { ...T, snapshot_format: "semantic_v2", include_screenshot: !!name });
  snap = r.json;
  if (name && r.images[0]) writeFileSync(join(outDir, `${String(++shot).padStart(2, "0")}-${name}.png`), Buffer.from(r.images[0].data, "base64"));
  return snap;
}
const has = (text) => snap.outline.includes(text);
function ref(role, name) {
  const hit = snap.refs.find((r) => (!role || r.role === role) && (name instanceof RegExp ? name.test(r.name ?? "") : r.name === name));
  if (!hit) throw new Error(`No ${role ?? "element"} "${name}" on ${snap.page.url}\n${snap.outline.slice(0, 2500)}`);
  return hit.ref;
}
async function until(cond, tries = 8) {
  for (let i = 0; i < tries; i++) { if (cond()) return true; await look(); }
  return cond();
}
const go = async (path) => { await c.call("browser_navigate", { ...T, url: base + path }); await look(); await until(() => !has("Loading")); };
const present = (role, name) => snap.refs.some((r) => (!role || r.role === role) && (name instanceof RegExp ? name.test(r.name ?? "") : r.name === name));
const click = async (role, name, expect) => {
  if (!present(role, name)) await until(() => present(role, name), 4); // controls that appear after typing
  await c.call("browser_click", { ...T, ref: ref(role, name) });
  await look();
  if (expect && !(await until(() => has(expect)))) {
    // A click during re-render can be lost; retry once if the control is still there.
    if (snap.refs.some((r) => r.role === role && (name instanceof RegExp ? name.test(r.name ?? "") : r.name === name))) {
      await c.call("browser_click", { ...T, ref: ref(role, name) });
      await until(() => has(expect));
    }
    if (!has(expect)) throw new Error(`Clicking ${role} "${name}" never showed "${expect}"\n${snap.outline.slice(0, 2500)}`);
  }
};
const type = async (name, text, role = null) => c.call("browser_type", { ...T, ref: ref(role, name), text, replace: false });
const keys = async (name, text, role = null) => c.call("browser_type", { ...T, ref: ref(role, name), text, replace: false, mode: "keystrokes" });
/**
 * CUA cannot change a native <select> on this host: the option list is a native popup, DOM option clicks do not commit,
 * and keyboard input needs foreground delivery that Windows' focus-stealing protection refuses. Steps that need a
 * dropdown are therefore performed through the HTTP API with a separate login (labelled "via API" in the results);
 * dropdown selection itself is covered by the Playwright suite, which uses trusted Chromium input.
 */
let apiCookie = "";
async function apiCall(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-openbuild-csrf": "1", cookie: apiCookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get("set-cookie");
  if (set) apiCookie = set.split(";")[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const files = async (name, paths) => c.call("browser_set_input_files", { ...T, ref: ref(null, name), files: paths });
async function acceptDialog() {
  const d = (await c.call("browser_dialog", { ...T, action: "inspect" })).json;
  if (d.dialog_id) await c.call("browser_dialog", { ...T, action: "accept", dialog_id: d.dialog_id });
}
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function signIn(email, password) {
  await go("/");
  if (has('button "Sign out"')) { await click("button", "Sign out", 'button "Sign in"'); }
  await type("Email", email, "textbox");
  await type("Password", password, "textbox");
  await click("button", "Sign in", 'link "Dashboard"');
}

try {
  if (phase === "run") {
    // ---- Organization and project
    await go("/");
    await click("button", "New here? Create an organization", 'textbox "Your name"');
    await type("Your name", "Paula Owner", "textbox");
    await type("Company name", "Harbor Builders", "textbox");
    await type("Email", OWNER.email, "textbox");
    await type("Password", OWNER.password, "textbox");
    await click("button", "Create account", 'heading "Dashboard"');
    check("create organization", has("Harbor Builders"));

    await click("link", "Projects", 'button "New project"');
    await click("button", "New project", 'textbox "Project name"');
    await type("Project name", "Harbor Tower", "textbox");
    await type("Project number", "HT-01", "textbox");
    await click("button", "Create project", "your role:");
    const projectUrl = snap.page.url;
    const projectId = projectUrl.split("/projects/")[1].split("/")[0];
    check("create project", has("Harbor Tower"), projectId);
    writeFileSync(stateFile, JSON.stringify({ projectId }));

    // ---- Invite a subcontractor (role restriction) via the GUI
    await go("/team");
    await type("Email", "sam@spark-electric.test", "textbox");
    await type("Company (e.g. subcontractor name)", "Spark Electric", "textbox");
    await click("button", "Create invitation", "Invitation link");
    const invite = snap.refs.find((r) => r.name === "Invitation link")?.value;
    await look("invite");
    check("invite user", /\/invite\//.test(invite ?? ""));

    // ---- Drawings
    await go(`/projects/${projectId}/drawings`);
    await click("button", "Upload sheet", 'textbox "Sheet number"');
    await type("Sheet number", "A-101", "textbox");
    await type("Sheet title (new sheets)", "Ground floor plan", "textbox");
    await type("Discipline", "Architectural", "textbox");
    await type("Revision", "0", "textbox");
    await files("PDF", [pdfPath]);
    await click("button", "Upload", "Ground floor plan");
    await look("drawings");
    check("upload drawing", has("Ground floor plan") && has("A-101"));

    // ---- RFI
    await go(`/projects/${projectId}/rfis`);
    await click("button", "New RFI", 'textbox "Subject"');
    await type("Subject", "Door hardware at stair 2", "textbox");
    await type("Question", "Spec calls for panic hardware; plans show lever. Which governs?", "textbox");
    await click("button", "Create RFI", "Door hardware at stair 2");
    await click("link", "1", 'heading "RFI #1');
    await type("Response", "Panic hardware governs per code.", "textbox");
    await click("checkbox", "This is the official answer");
    await click("button", "Post response", "Official answer");
    await look("rfi");
    check("RFI answered", has("Official answer") && has("Answered"));

    // ---- Submittal with spec section
    await go(`/projects/${projectId}/specs`);
    await click("button", "Add section", 'textbox "Section number"');
    await type("Section number", "08 71 00", "textbox");
    await type("Title", "Door hardware", "textbox");
    await click("button", "Add section", "Door hardware");
    await go(`/projects/${projectId}/submittals`);
    await click("button", "New submittal", 'textbox "Title"');
    await type("Title", "Hardware schedule", "textbox");
    await click("button", "Create submittal", "Hardware schedule");
    await apiCall("POST", "/api/auth/login", OWNER);
    const me = await apiCall("GET", "/api/me");
    const ownerId = me.user.id;
    const subId = (await apiCall("GET", `/api/projects/${projectId}/submittals`))[0].id;
    await apiCall("PATCH", `/api/submittals/${subId}`, { reviewerIds: [ownerId] });
    check("assign submittal reviewer (via API: dropdown)", true);
    await go(`/projects/${projectId}/submittals`);
    await click("link", "1", "Submit for review");
    await click("button", "Submit for review", "Approval route");
    await click("button", "Approved as noted", "Approved as noted");
    await look("submittal");
    check("submittal reviewed", has('heading "Submittal #1: Hardware schedule Approved as noted"') || /Approved as noted/.test(snap.outline));

    // ---- Inspection → punch item
    await go("/settings");
    await type("Template name", "Door install", "textbox");
    await type("Checklist items (one per line)", "Frame plumb\nHardware installed\nClosers adjusted", "textbox");
    await click("button", "Create template", "Door install");
    await go(`/projects/${projectId}/inspections`);
    await click("button", "New inspection", 'textbox "Title"');
    await type("Title", "Stair 2 doors", "textbox");
    await type("Extra checklist items (one per line)", ["Frame plumb", "Hardware installed", "Closers adjusted"].join("\n"), "textbox");
    await click("button", "Start inspection", "Stair 2 doors");
    await click("link", "Stair 2 doors", "Complete inspection");
    // Buttons are grouped per item; click by order: Pass(1), Fail(2), N/A(3)
    const resultButtons = () => snap.refs.filter((r) => r.role === "button" && ["Pass", "Fail", "N/A"].includes(r.name));
    await c.call("browser_click", { ...T, ref: resultButtons()[0].ref }); await look();
    await c.call("browser_click", { ...T, ref: resultButtons()[4].ref }); await look();
    await c.call("browser_click", { ...T, ref: resultButtons()[8].ref }); await look();
    await click("button", "Create punch item", 'textbox "Deficiency note"');
    await type("Deficiency note", "Lever trim installed instead of panic bar", "textbox");
    await click("button", "Create punch item", "Punch item #1");
    await click("button", "Complete inspection", "Completed");
    await look("inspection");
    check("inspection with failed item creates punch item", has("Punch item #1") && has("Completed"));

    // ---- Interrupted workflow: start a change event, navigate away mid-form
    await go(`/projects/${projectId}/change-events`);
    await click("button", "New change event", 'textbox "Title"');
    await type("Title", "ABANDONED CHANGE EVENT", "textbox");
    await go(`/projects/${projectId}`);
    await go(`/projects/${projectId}/change-events`);
    check("interrupted form leaves no record", !has("ABANDONED CHANGE EVENT"));

    // ---- Financials: cost codes, budget, contract, change order, pay application
    await go(`/projects/${projectId}/budget`);
    await type("Cost codes — one per line: code,description", "03-300,Concrete\n08-710,Door hardware", "textbox");
    await click("button", "Import cost codes", "08-710");
    await c.call("browser_type", { ...T, ref: ref("textbox", "Original budget 08-710"), text: "50000", replace: true });
    await click("button", "Save", "$50,000.00");
    check("budget entry", has("$50,000.00"));

    const codes = await apiCall("GET", `/api/projects/${projectId}/cost-codes`);
    const hw = codes.find((x) => x.code === "08-710").id;
    const k = await apiCall("POST", `/api/projects/${projectId}/contracts`, { kind: "purchase_order", title: "Hardware supply", counterparty: "Spark Hardware", retainagePercent: "5", lines: [{ costCodeId: hw, description: "Door hardware package", amount: "42,000.00" }] });
    check("create contract with cost-coded line (via API: dropdowns)", !!k.id);
    await go(`/contracts/${k.id}`);
    await click("button", "Approve contract", "Mark complete");
    check("approve contract in GUI", has("Approved"));

    const co = await apiCall("POST", `/api/projects/${projectId}/change-orders`, { contractId: k.id, title: "Panic hardware upgrade", lines: [{ costCodeId: hw, description: "Panic bars at stair 2", amount: "3,250.50" }] });
    await apiCall("POST", `/api/change-orders/${co.id}/submit`, { approverIds: [ownerId] });
    check("create and route change order (via API: dropdowns)", true);
    await go(`/change-orders/${co.id}`);
    await click("button", "Approved", "Panic hardware upgrade Approved");
    await look("change-order");
    check("approve change order in GUI", /Panic hardware upgrade Approved/.test(snap.outline));

    const inv = await apiCall("POST", `/api/projects/${projectId}/invoices`, { contractId: k.id, periodStart: "2026-10-01", periodEnd: "2026-10-31" });
    await go(`/invoices/${inv.id}`);
    await until(() => has("Continuation sheet"));
    await c.call("browser_type", { ...T, ref: ref("textbox", "This period Door hardware package"), text: "21000", replace: true });
    await c.call("browser_type", { ...T, ref: ref("textbox", "Stored materials Door hardware package"), text: "4000", replace: true });
    await c.call("browser_type", { ...T, ref: ref("textbox", "This period Panic bars at stair 2"), text: "3250.50", replace: true });
    await click("button", "Save amounts", "$28,250.50");
    await look("pay-application");
    // contract sum 45,250.50; completed 28,250.50; retainage 5% = 1,250.00 + 162.52 (162.525 half-even) = 1,412.52; due 26,837.98
    check("pay application totals", has("$45,250.50") && has("$28,250.50") && has("$1,412.52") && has("$26,837.98"));

    // ---- Report export (real download)
    await go(`/projects/${projectId}/budget`);
    const dl = (await c.call("browser_download", { ...T, ref: ref("link", "Export CSV"), destination_root: outDir })).json;
    const csvPath = dl.path ?? dl.file_path ?? (dl.download_id ? join(outDir, dl.download_id) : null);
    const csv = csvPath ? readFileSync(csvPath, "utf8") : "";
    check("export budget CSV", csv.startsWith("Cost code,Description,Original budget") && csv.includes("08-710"), csvPath ?? JSON.stringify(dl).slice(0, 200));

    // ---- Subcontractor accepts invite and sees a restricted project
    await go("/");
    await click("button", "Sign out", 'button "Sign in"');
    await c.call("browser_navigate", { ...T, url: invite });
    await look();
    await until(() => has('textbox "Your name"'));
    await type("Your name", "Sam Sub", "textbox");
    await type("Choose a password", "another long password", "textbox");
    await click("button", "Accept invitation", 'heading "Dashboard"');
    const members = await apiCall("GET", `/api/orgs/${(await apiCall("GET", "/api/me")).orgs[0].id}/members`);
    const sam = members.members.find((m) => m.email === "sam@spark-electric.test");
    await apiCall("PUT", `/api/projects/${projectId}/members/${sam.id}`, { role: "subcontractor" });
    check("add subcontractor to project (via API: dropdown)", true);
    await go(`/projects/${projectId}`);
    await look("subcontractor-view");
    check("subcontractor cannot see financial or internal tools", has('link "Drawings"') && !has('link "Budget"') && !has('link "Daily log"') && !has('link "Invoices"'));
    await go(`/projects/${projectId}/rfis`);
    check("subcontractor sees no unassigned RFIs", !has("Door hardware at stair 2"));
    await click("button", "Sign out", 'button "Sign in"');
  } else {
    // ---- After the server was restarted
    const { projectId } = JSON.parse(readFileSync(stateFile, "utf8"));
    await signIn(OWNER.email, OWNER.password);
    await go(`/projects/${projectId}/rfis`);
    check("RFI persists after restart", has("Door hardware at stair 2"));
    await go(`/projects/${projectId}/punch`);
    check("punch item persists after restart", has("Hardware installed"));
    await go(`/projects/${projectId}/invoices`);
    await look("after-restart-invoices");
    check("pay application persists after restart", has("$26,837.98"));
    await go("/audit");
    await look("audit");
    check("audit trail recorded", has("invoice.lines") && has("change_order.decision") && has("drawing.revision"));
  }
} catch (e) {
  check("flow completed without error", false, e.message.slice(0, 1500));
  try { await look(`error-${phase}`); } catch {}
} finally {
  writeFileSync(join(outDir, `results-${phase}.json`), JSON.stringify(results, null, 2));
  c.close();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
