// Starts the built server against a fresh, throwaway embedded database.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PGLITE_DIR = mkdtempSync(join(tmpdir(), "openbuild-e2e-"));
await import("../apps/api/dist/main.js");
