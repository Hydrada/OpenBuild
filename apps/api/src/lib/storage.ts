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
