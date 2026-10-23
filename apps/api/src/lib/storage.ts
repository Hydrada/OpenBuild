import { createReadStream, mkdirSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

/**
 * Blob storage for uploaded files. Keys are server-generated (never user input).
 * The local-disk driver is the default; an S3-compatible driver can implement the same interface.
 */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class LocalStorage implements Storage {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    return createReadStream(this.path(key));
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async exists(key: string) {
    return stat(this.path(key)).then(() => true, () => false);
  }
}

export interface S3Options {
  bucket: string;
  region?: string;
  /** For MinIO, R2, Backblaze, etc. Omit for AWS. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Path-style URLs (required by most self-hosted S3 servers). */
  forcePathStyle?: boolean;
  prefix?: string;
}

/** S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, Backblaze B2...). */
export class S3Storage implements Storage {
  private client: import("@aws-sdk/client-s3").S3Client | null = null;
  private sdk: typeof import("@aws-sdk/client-s3") | null = null;
  constructor(private opts: S3Options) {}

  private async c() {
    if (!this.client) {
      this.sdk = await import("@aws-sdk/client-s3");
      this.client = new this.sdk.S3Client({
        region: this.opts.region ?? "us-east-1",
        endpoint: this.opts.endpoint,
        forcePathStyle: this.opts.forcePathStyle ?? !!this.opts.endpoint,
        credentials: this.opts.accessKeyId ? { accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey ?? "" } : undefined,
      });
    }
    return { client: this.client, sdk: this.sdk! };
  }
  private key(key: string) {
    if (key.includes("..") || key.startsWith("/")) throw new Error("Invalid storage key");
    return (this.opts.prefix ?? "") + key;
  }
  async put(key: string, data: Buffer) {
    const { client, sdk } = await this.c();
    await client.send(new sdk.PutObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key), Body: data }));
  }
  async get(key: string) {
    const { client, sdk } = await this.c();
    const r = await client.send(new sdk.GetObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key) }));
    return r.Body as Readable;
  }
  async delete(key: string) {
    const { client, sdk } = await this.c();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key) }));
  }
  async exists(key: string) {
    const { client, sdk } = await this.c();
    try {
      await client.send(new sdk.HeadObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key) }));
      return true;
    } catch {
      return false;
    }
  }
}

/** OPENBUILD_S3_BUCKET selects S3; otherwise local disk. */
export function storageFromEnv(env: NodeJS.ProcessEnv, localDir: string): Storage {
  if (!env.OPENBUILD_S3_BUCKET) return new LocalStorage(localDir);
  return new S3Storage({
    bucket: env.OPENBUILD_S3_BUCKET,
    region: env.OPENBUILD_S3_REGION,
    endpoint: env.OPENBUILD_S3_ENDPOINT || undefined,
    accessKeyId: env.OPENBUILD_S3_ACCESS_KEY_ID,
    secretAccessKey: env.OPENBUILD_S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.OPENBUILD_S3_FORCE_PATH_STYLE ? env.OPENBUILD_S3_FORCE_PATH_STYLE === "true" : undefined,
    prefix: env.OPENBUILD_S3_PREFIX,
  });
}
