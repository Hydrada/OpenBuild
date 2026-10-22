// Minimal persistent MCP stdio client for `cua-driver mcp`. One transport = one CUA session,
// so a driver-owned isolated browser survives across calls.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export async function connect() {
  const proc = spawn("cua-driver", ["mcp"], { stdio: ["pipe", "pipe", "inherit"], shell: process.platform === "win32" });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openbuild-gui-test", version: "0.1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  /** Calls a tool; returns { json, images } parsed from the content parts. */
  async function call(name, args = {}) {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
    let json = r.structuredContent;
    if (!json) { try { json = JSON.parse(text); } catch { json = { text }; } }
    const images = r.content?.filter((c) => c.type === "image") ?? [];
    if (r.isError || json?.status === "refused") throw new Error(`${name}: ${text.slice(0, 800)}`);
    return { json, images };
  }
  return { call, close: () => proc.kill() };
}
