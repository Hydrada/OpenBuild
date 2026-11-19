import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Queryable } from "../db/db.js";
import { HttpError } from "./errors.js";
import type { Storage } from "./storage.js";
import type { Scanner } from "./virus-scan.js";

export interface Upload {
  fields: Record<string, string>;
  file: { name: string; mime: string; data: Buffer } | null;
}

/** Reads a multipart request: text fields plus at most one file (field name "file"). */
export async function readUpload(req: FastifyRequest): Promise<Upload> {
  if (!req.isMultipart()) throw new HttpError(415, "Expected multipart/form-data");
  const fields: Record<string, string> = {};
  let file: Upload["file"] = null;
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (file) throw new HttpError(400, "Only one file per request");
      const data = await part.toBuffer();
      file = { name: sanitizeName(part.filename || "file"), mime: part.mimetype || "application/octet-stream", data };
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  if (file) await scanUpload(req, file);
  return { fields, file };
}

/**
 * Runs the configured scanner. Infected files are refused (422). If the scanner cannot be reached the upload is
 * refused too (503), unless the operator chose to fail open, in which case it is accepted and a warning is logged.
 */
async function scanUpload(req: FastifyRequest, file: NonNullable<Upload["file"]>) {
  const cfg = (req.server as unknown as { uploadScan: { scan: Scanner; failOpen?: boolean } | null }).uploadScan;
  if (!cfg) return;
  let result;
  try {
    result = await cfg.scan(file.data);
  } catch (e) {
    if (cfg.failOpen) {
      req.log.warn({ err: (e as Error).message, file: file.name }, "virus scan skipped: scanner unavailable");
      return;
    }
    throw new HttpError(503, "Uploads are paused because the virus scanner is unavailable. Try again shortly.");
  }
  if (!result.clean) {
    req.log.warn({ signature: result.signature, file: file.name }, "upload rejected: malware detected");
    throw new HttpError(422, `This file was rejected by the virus scanner (${result.signature}).`);
  }
}

export function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[\u0000-\u001f"<>|:*?]/g, "_").slice(0, 200) || "file";
}

export function isPdf(data: Buffer): boolean {
  return data.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** Persists the blob and its metadata row. Call inside the caller's transaction for the row part. */
export async function storeFile(
  q: Queryable,
  storage: Storage,
  opts: { orgId: string; projectId: string | null; userId: string; file: NonNullable<Upload["file"]> },
): Promise<{ id: string; name: string; mime: string; size: number }> {
  if (!opts.file.data.length) throw new HttpError(400, "The file is empty");
  const key = `${opts.orgId}/${opts.projectId ?? "org"}/${randomUUID()}`;
  await storage.put(key, opts.file.data);
  const sha = createHash("sha256").update(opts.file.data).digest("hex");
  const [row] = await q.query<{ id: string; name: string; mime: string; size: number }>(
    `INSERT INTO files (org_id, project_id, storage_key, name, mime, size, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, mime, size`,
    [opts.orgId, opts.projectId, key, opts.file.name, opts.file.mime, opts.file.data.length, sha, opts.userId],
  );
  return row!;
}

/** Content types we are willing to render inline; everything else downloads. */
export const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);
