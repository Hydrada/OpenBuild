import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPgliteDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createNotifier } from "../src/lib/notify.js";
import { LocalStorage } from "../src/lib/storage.js";
import { clamdScanner, scannerFromEnv } from "../src/lib/virus-scan.js";
import { registerOwner } from "./helpers.js";

/** The standard antivirus test string (harmless by design). */
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** A minimal clamd: parses INSTREAM framing exactly and reports EICAR as found. */
function fakeClamd(): Promise<{ server: Server; port: number; streams: number[] }> {
  const streams: number[] = [];
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let header = false;
    const body: Buffer[] = [];
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!header) {
        const cmd = "zINSTREAM\0";
        if (buf.length < cmd.length) return;
        if (buf.subarray(0, cmd.length).toString() !== cmd) { sock.end("UNKNOWN COMMAND\0"); return; }
        buf = buf.subarray(cmd.length);
        header = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const data = Buffer.concat(body);
          streams.push(data.length);
          sock.end(data.toString("latin1").includes(EICAR) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (buf.length < 4 + len) return;
        body.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, streams })));
}

let clamd: Awaited<ReturnType<typeof fakeClamd>>;
beforeAll(async () => { clamd = await fakeClamd(); });
afterAll(() => new Promise<void>((r) => clamd.server.close(() => r())));

async function appWith(virusScan: Parameters<typeof buildApp>[0]["virusScan"]) {
  const db = await createPgliteDb();
  await migrate(db);
  const app = await buildApp({ db, storage: new LocalStorage(mkdtempSync(join(tmpdir(), "ob-scan-"))), allowSignup: true, secureCookies: false, notify: createNotifier(), documentTools: [], virusScan });
  const { client, orgId } = await registerOwner(app);
  const projectId = (await client.post(`/api/orgs/${orgId}/projects`, { name: "Scan test" })).body.id;
  const upload = (name: string, data: string | Buffer) => client.upload(`/api/projects/${projectId}/files`, {}, { name, type: "application/octet-stream", data });
  return { app, db, upload, client, projectId };
}

describe("virus scanning", () => {
  it("speaks clamd INSTREAM, including multi-chunk files", async () => {
    const scan = clamdScanner("127.0.0.1", clamd.port);
    expect(await scan(Buffer.from("hello"))).toEqual({ clean: true });
    expect(await scan(Buffer.from(`prefix ${EICAR} suffix`))).toEqual({ clean: false, signature: "Eicar-Test-Signature" });
    const big = Buffer.alloc(200 * 1024, 7);
    expect(await scan(big)).toEqual({ clean: true });
    expect(clamd.streams).toContain(200 * 1024);
    expect(() => scannerFromEnv({ OPENBUILD_CLAMD: "nope" })).toThrow(/host:port/);
    expect(scannerFromEnv({})).toBeUndefined();
  });

  it("rejects infected uploads and stores clean ones", async () => {
    const { app, db, upload, client, projectId } = await appWith({ scan: clamdScanner("127.0.0.1", clamd.port) });
    try {
      const bad = await upload("invoice.pdf.exe", EICAR);
      expect(bad.status).toBe(422);
      expect(bad.body.error).toBe("This file was rejected by the virus scanner (Eicar-Test-Signature).");
      expect((await upload("notes.txt", "clean")).status).toBe(201);
      expect((await client.get(`/api/projects/${projectId}/files`)).body.map((f: { name: string }) => f.name)).toEqual(["notes.txt"]);
    } finally {
      await app.close(); await db.close();
    }
  });

  it("fails closed when the scanner is down, unless configured to fail open", async () => {
    const closed = await appWith({ scan: clamdScanner("127.0.0.1", 1, 2000) });
    try {
      const r = await closed.upload("a.txt", "x");
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/virus scanner is unavailable/);
    } finally {
      await closed.app.close(); await closed.db.close();
    }
    const open = await appWith({ scan: clamdScanner("127.0.0.1", 1, 2000), failOpen: true });
    try {
      expect((await open.upload("a.txt", "x")).status).toBe(201);
    } finally {
      await open.app.close(); await open.db.close();
    }
  });
});
