/**
 * Usage:
 *   openbuild-backup backup  <out-dir>   writes <out-dir>/database.json and copies the file store to <out-dir>/files
 *   openbuild-backup restore <in-dir>    restores into an EMPTY database (run migrations first; this does it)
 * Uses the same DATABASE_URL / PGLITE_DIR / OPENBUILD_STORAGE_DIR settings as the server. Stop the server first.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Backup, exportAll, importAll } from "./backup.js";
import { createDb } from "./db.js";
import { migrate } from "./migrate.js";

const [cmd, dir] = process.argv.slice(2);
if (!cmd || !dir || !["backup", "restore"].includes(cmd)) {
  console.error("Usage: backup|restore <directory>");
  process.exit(2);
}
const storageDir = resolve(process.env.OPENBUILD_STORAGE_DIR ?? "./data/files");
const db = await createDb(process.env);
try {
  await migrate(db);
  if (cmd === "backup") {
    mkdirSync(dir, { recursive: true });
    const backup = await exportAll(db);
    writeFileSync(join(dir, "database.json"), JSON.stringify(backup));
    if (existsSync(storageDir)) cpSync(storageDir, join(dir, "files"), { recursive: true });
    const rows = Object.values(backup.tables).reduce((n, t) => n + t.length, 0);
    console.log(`Backup written to ${resolve(dir)} (${rows} rows).`);
  } else {
    const backup = JSON.parse(readFileSync(join(dir, "database.json"), "utf8")) as Backup;
    const counts = await importAll(db, backup);
    if (existsSync(join(dir, "files"))) cpSync(join(dir, "files"), storageDir, { recursive: true });
    console.log(`Restored ${Object.values(counts).reduce((a, b) => a + b, 0)} rows into the database and files into ${storageDir}.`);
  }
} finally {
  await db.close();
}
