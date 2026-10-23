import type { Db } from "./db.js";
import { migrations } from "./migrations/index.js";

/** Tables in foreign-key order (parents first). Every application table must be listed. */
export const TABLE_ORDER = [
  "users", "organizations", "org_memberships", "sessions", "oidc_states", "password_resets", "api_keys",
  "projects", "project_holidays", "project_memberships", "invitations", "tasks",
  "files", "attachments", "drawings", "drawing_revisions", "markup_sets", "tool_tokens",
  "folders", "documents", "document_versions", "approval_steps", "spec_sections",
  "rfis", "rfi_responses", "submittals", "notifications", "comments",
  "daily_logs", "daily_log_manpower", "inspection_templates", "inspections", "punch_items", "inspection_items",
  "observations", "incidents",
  "cost_codes", "budget_lines", "budget_modifications", "contracts", "contract_lines",
  "change_events", "change_event_lines", "change_orders", "change_order_lines", "invoices", "invoice_lines",
  "schedule_resources", "schedule_items", "schedule_links", "meetings", "meeting_items", "timesheet_entries", "bidder_companies", "bid_packages", "bidders", "bid_package_files", "bim_models", "bim_model_versions", "clash_runs", "custom_field_defs", "custom_field_values", "audit_log",
] as const;

export interface Backup {
  format: "openbuild-backup";
  version: 1;
  createdAt: string;
  migrations: string[];
  tables: Record<string, Record<string, unknown>[]>;
}

export async function exportAll(db: Db): Promise<Backup> {
  await assertAllTablesListed(db);
  const tables: Backup["tables"] = {};
  // One snapshot transaction so the dump is consistent.
  await db.tx(async (q) => {
    await q.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    for (const t of TABLE_ORDER) tables[t] = await q.query(`SELECT * FROM ${t}`);
  });
  const applied = (await db.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id")).map((r) => r.id);
  return { format: "openbuild-backup", version: 1, createdAt: new Date().toISOString(), migrations: applied, tables };
}

/** Restores into a freshly migrated, empty database. Refuses to overwrite existing data. */
export async function importAll(db: Db, backup: Backup): Promise<Record<string, number>> {
  if (backup.format !== "openbuild-backup" || backup.version !== 1) throw new Error("Not an OpenBuild backup file");
  const known = new Set(migrations.map((m) => m.id));
  const unknown = backup.migrations.filter((m) => !known.has(m));
  if (unknown.length) throw new Error(`Backup is from a newer version (migrations ${unknown.join(", ")}); upgrade OpenBuild first`);
  const [{ n }] = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM users")) as [{ n: number }];
  if (n > 0) throw new Error("Target database is not empty; restore into a new database");

  const jsonCols = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND data_type = 'jsonb'`,
  );
  const isJson = new Set(jsonCols.map((c) => `${c.table_name}.${c.column_name}`));
  const counts: Record<string, number> = {};
  await db.tx(async (q) => {
    for (const t of TABLE_ORDER) {
      const rows = backup.tables[t] ?? [];
      for (const row of rows) {
        const cols = Object.keys(row);
        const values = cols.map((c) => (isJson.has(`${t}.${c}`) && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
        await q.query(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, values);
      }
      counts[t] = rows.length;
    }
    await q.query(`SELECT setval(pg_get_serial_sequence('audit_log', 'id'), coalesce((SELECT max(id) FROM audit_log), 0) + 1, false)`);
  });
  return counts;
}

async function assertAllTablesListed(db: Db) {
  const rows = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`,
  );
  const missing = rows.map((r) => r.table_name).filter((t) => !(TABLE_ORDER as readonly string[]).includes(t));
  if (missing.length) throw new Error(`Backup does not cover tables: ${missing.join(", ")}`);
}
