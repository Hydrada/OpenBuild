#!/usr/bin/env node
// Watches the GitHub repo for new issues and comments and flags anything that sounds like a problem report.
// Plain script: GitHub REST API + keyword rules. No AI, no paid services.
//
//   node scripts/feedback-watch.mjs            check once (what the scheduled task runs)
//   node scripts/feedback-watch.mjs --since 7d  look back further on the first run (default 2 days)
//   node scripts/feedback-watch.mjs --dry-run   print matches without updating state or alerting
//
// Auth: GITHUB_TOKEN / GH_TOKEN, otherwise the token Git already stores for github.com.
// Output: a Windows notification for each flagged item, and every item appended to
// %USERPROFILE%\OpenBuildFeedback\inbox.md (flagged ones marked). State lives next to it in state.json.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = process.env.OPENBUILD_REPO ?? "Hydrada/OpenBuild";
const DIR = process.env.OPENBUILD_FEEDBACK_DIR ?? join(homedir(), "OpenBuildFeedback");
const STATE = join(DIR, "state.json");
const INBOX = join(DIR, "inbox.md");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sinceArg = args[args.indexOf("--since") + 1];

/** Words and phrases that usually mean "something is wrong". Matched case-insensitively on whole words. */
const PROBLEM = [
  "bug", "bugs", "broken", "breaks", "crash", "crashes", "crashed", "error", "errors", "exception", "fail", "fails", "failed", "failing",
  "doesn't work", "does not work", "not working", "isn't working", "won't", "can't", "cannot", "unable", "stuck", "freeze", "freezes", "hang", "hangs",
  "wrong", "incorrect", "missing", "lost", "blank", "500", "404", "slow", "regression", "issue", "problem", "glitch", "data loss", "security", "vulnerability",
];
const URGENT = ["data loss", "lost", "security", "vulnerability", "crash", "crashes", "500", "can't log in", "cannot log in", "down"];

function token() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  try {
    const out = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    return /^password=(.+)$/m.exec(out)?.[1];
  } catch { return undefined; }
}

async function me() {
  const res = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token()}`, "User-Agent": "openbuild-feedback-watch" } });
  return res.ok ? (await res.json()).login : null;
}

async function gh(path) {
  const t = token();
  if (!t) throw new Error("No GitHub token: set GITHUB_TOKEN or sign in to GitHub with Git");
  const out = [];
  let url = `https://api.github.com${path}`;
  for (let page = 0; url && page < 10; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "User-Agent": "openbuild-feedback-watch" } });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
    out.push(...(await res.json()));
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
  }
  return out;
}

const words = (list) => new RegExp(`(^|[^a-z0-9])(${list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['\u2019]")).join("|")})(?=$|[^a-z0-9])`, "i");
const PROBLEM_RE = words(PROBLEM), URGENT_RE = words(URGENT);

function classify(text, isNewIssue, labels) {
  const hit = PROBLEM_RE.exec(text)?.[2];
  const bugLabel = labels.some((l) => /bug|defect|regression|security/i.test(l));
  const flagged = isNewIssue || !!hit || bugLabel;
  const urgent = URGENT_RE.test(text) || labels.some((l) => /security|critical|urgent/i.test(l));
  return { flagged, urgent, reason: bugLabel ? "bug label" : hit ? `mentions "${hit}"` : isNewIssue ? "new issue" : "" };
}

function notify(title, body) {
  if (process.platform !== "win32") { console.log(`ALERT: ${title} - ${body}`); return; }
  // Built-in Windows tray balloon; no modules to install.
  const esc = (s) => s.replace(/'/g, "''").slice(0, 240);
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Warning; $n.Visible = $true; $n.ShowBalloonTip(15000, '${esc(title)}', '${esc(body)}', 'Warning'); Start-Sleep -Seconds 16; $n.Dispose()`;
  spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { stdio: "ignore", windowsHide: true });
}

function parseSince(s) {
  const m = /^(\d+)([dh])$/.exec(s ?? "");
  const ms = m ? Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000) : 2 * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { since: parseSince(sinceArg), seen: [] };
  const seen = new Set(state.seen);
  const startedAt = new Date().toISOString();
  const since = encodeURIComponent(state.since);

  // Your own posts never alert you (set OPENBUILD_WATCH_SELF=1 to include them, e.g. for testing).
  const self = process.env.OPENBUILD_WATCH_SELF ? null : await me();
  const [issues, issueComments, reviewComments] = await Promise.all([
    gh(`/repos/${REPO}/issues?state=all&since=${since}&per_page=100&sort=updated&direction=asc`),
    gh(`/repos/${REPO}/issues/comments?since=${since}&per_page=100&sort=updated&direction=asc`),
    gh(`/repos/${REPO}/pulls/comments?since=${since}&per_page=100&sort=updated&direction=asc`),
  ]);

  const items = [];
  for (const i of issues) {
    const key = `issue:${i.id}`;
    if (seen.has(key) || i.created_at < state.since) continue; // updated old issues show up through their comments
    items.push({ key, kind: i.pull_request ? "Pull request" : "Issue", title: `#${i.number} ${i.title}`, author: i.user?.login, url: i.html_url, at: i.created_at,
      text: `${i.title}\n${i.body ?? ""}`, isNewIssue: !i.pull_request, labels: (i.labels ?? []).map((l) => l.name) });
  }
  for (const c of [...issueComments, ...reviewComments]) {
    const key = `comment:${c.id}`;
    if (seen.has(key) || c.created_at < state.since) continue;
    const num = /\/(?:issues|pull)\/(\d+)/.exec(c.html_url)?.[1] ?? "?";
    items.push({ key, kind: "Comment", title: `on #${num}`, author: c.user?.login, url: c.html_url, at: c.created_at, text: c.body ?? "", isNewIssue: false, labels: [] });
  }
  items.sort((a, b) => (a.at < b.at ? -1 : 1));

  const flagged = [];
  for (const it of items) {
    if (/\[bot\]$/.test(it.author ?? "") || (self && it.author === self)) { seen.add(it.key); continue; }
    const c = classify(it.text, it.isNewIssue, it.labels);
    const excerpt = it.text.replace(/\s+/g, " ").trim().slice(0, 300);
    const line = `- ${c.flagged ? (c.urgent ? "**URGENT** " : "**FLAG** ") : ""}${it.at.replace("T", " ").slice(0, 16)} UTC · ${it.kind} ${it.title} by @${it.author}${c.reason ? ` (${c.reason})` : ""}\n  ${it.url}\n  > ${excerpt}\n`;
    if (dryRun) console.log(line);
    else appendFileSync(INBOX, line);
    if (c.flagged) flagged.push({ ...it, ...c, excerpt });
    seen.add(it.key);
  }

  if (!dryRun) {
    if (flagged.length === 1) notify(`OpenBuild: ${flagged[0].urgent ? "URGENT " : ""}${flagged[0].kind} ${flagged[0].title}`, `@${flagged[0].author}: ${flagged[0].excerpt}`);
    else if (flagged.length > 1) notify(`OpenBuild: ${flagged.length} possible problem reports${flagged.some((f) => f.urgent) ? " (urgent)" : ""}`, flagged.map((f) => `${f.kind} ${f.title}`).join("; "));
    // Keep the seen list bounded; the "since" cursor already excludes older items.
    writeFileSync(STATE, JSON.stringify({ since: startedAt, seen: [...seen].slice(-5000) }, null, 2));
  }
  console.log(`${new Date().toISOString()} checked ${REPO}: ${items.length} new item(s), ${flagged.length} flagged${flagged.length ? ` -> ${INBOX}` : ""}`);
}

main().catch((e) => {
  console.error(`feedback-watch failed: ${e.message}`);
  if (!dryRun) {
    try { mkdirSync(DIR, { recursive: true }); appendFileSync(join(DIR, "errors.log"), `${new Date().toISOString()} ${e.message}\n`); } catch { /* ignore */ }
  }
  process.exit(1);
});
