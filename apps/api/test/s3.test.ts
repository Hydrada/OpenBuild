import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPgliteDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createNotifier } from "../src/lib/notify.js";
import { S3Storage } from "../src/lib/storage.js";
import { PDF, registerOwner } from "./helpers.js";

/** Minimal path-style S3 server: PUT/GET/HEAD/DELETE objects in memory, records signed requests. */
let server: Server;
let endpoint: string;
const objects = new Map<string, Buffer>();
const seen: { method: string; path: string; signed: boolean }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
    seen.push({ method: req.method!, path, signed: /^AWS4-HMAC-SHA256 Credential=test-key\//.test(req.headers.authorization ?? "") });
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") {
        let body = Buffer.concat(chunks);
        // The SDK may send aws-chunked bodies with trailing checksums; decode them.
        if (String(req.headers["content-encoding"] ?? "").includes("aws-chunked")) {
          const out: Buffer[] = []; let i = 0;
          while (i < body.length) {
            const nl = body.indexOf("\r\n", i); const size = parseInt(body.subarray(i, nl).toString().split(";")[0]!, 16);
            if (!size) break; out.push(body.subarray(nl + 2, nl + 2 + size)); i = nl + 2 + size + 2;
          }
          body = Buffer.concat(out);
        }
        objects.set(path, body); res.writeHead(200, { ETag: '"x"' }); return res.end();
      }
      const obj = objects.get(path);
      if (req.method === "DELETE") { objects.delete(path); res.writeHead(204); return res.end(); }
      if (!obj) { res.writeHead(404, { "content-type": "application/xml" }); return res.end("<Error><Code>NoSuchKey</Code></Error>"); }
      res.writeHead(200, { "content-length": String(obj.length), "content-type": "application/octet-stream" });
      res.end(req.method === "HEAD" ? undefined : obj);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("S3-compatible storage", () => {
  it("puts, gets, checks and deletes objects with signed path-style requests", async () => {
    const s = new S3Storage({ bucket: "ob", endpoint, accessKeyId: "test-key", secretAccessKey: "secret", prefix: "prod/" });
    await s.put("org/p/1", Buffer.from("hello"));
    expect(objects.get("/ob/prod/org/p/1")?.toString()).toBe("hello");
    const chunks: Buffer[] = [];
    for await (const c of await s.get("org/p/1")) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    expect(await s.exists("org/p/1")).toBe(true);
    await s.delete("org/p/1");
    expect(await s.exists("org/p/1")).toBe(false);
    expect(seen.every((r) => r.signed)).toBe(true);
    await expect(s.put("../escape", Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
  });

  it("serves the app's uploads and downloads from the bucket", async () => {
    const db = await createPgliteDb();
    await migrate(db);
    const app = await buildApp({ db, storage: new S3Storage({ bucket: "ob", endpoint, accessKeyId: "test-key", secretAccessKey: "s" }), allowSignup: true, secureCookies: false, notify: createNotifier(), documentTools: [] });
    try {
      const { client, orgId } = await registerOwner(app);
      const pid = (await client.post(`/api/orgs/${orgId}/projects`, { name: "S3 tower" })).body.id;
      const up = await client.upload(`/api/projects/${pid}/drawings`, { number: "A-1", title: "Plan", revision: "0" }, { name: "a.pdf", type: "application/pdf", data: PDF("from-s3") });
      expect(up.status).toBe(201);
      expect([...objects.keys()].some((k) => k.startsWith(`/ob/${orgId}/${pid}/`))).toBe(true);
      const fileId = (await client.get(`/api/drawings/${up.body.drawingId}`)).body.revisions[0].file_id;
      const dl = await client.raw(`/api/files/${fileId}/download`);
      expect(dl.statusCode).toBe(200);
      expect(dl.body).toContain("from-s3");
    } finally {
      await app.close();
      await db.close();
    }
  });
});
