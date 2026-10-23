import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { toCsv } from "../lib/finance.js";
import { dec, fmt, sum } from "../lib/money.js";
import { getOrgRole, isUuid, requireOrgRole, requireProject, toolLevels } from "../lib/permissions.js";
import { DATASET_TOOL } from "../lib/tools.js";
import { DATASETS, PROJECT_COLUMN, type ColumnDef } from "../lib/reports.js";

const datasetKey = z.enum(Object.keys(DATASETS) as [string, ...string[]]);

/** What to show. Keys are validated against the dataset's whitelist before any SQL is built. */
export const reportConfig = z.object({
  columns: z.array(z.string()).min(1).max(30),
  statuses: z.array(z.string()).max(20).default([]),
  from: z.iso.date().nullable().optional(),
  to: z.iso.date().nullable().optional(),
  text: z.string().trim().max(100).nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
  groupBy: z.string().nullable().optional(),
  /** Numeric/money column to total in each group (and overall). */
  sumColumn: z.string().nullable().optional(),
  sort: z.string().nullable().optional(),
  sortDesc: z.boolean().default(false),
});
type ReportConfig = z.infer<typeof reportConfig>;

/** Projects in the org whose full records the user may read (org admins: all; others: manager/contributor/viewer). */
async function readableProjects(q: Queryable, userId: string, orgId: string): Promise<string[]> {
  const role = await getOrgRole(q, userId, orgId);
  if (!role) throw new HttpError(404, "Organization not found");
  const rows = role === "owner" || role === "admin"
    ? await q.query<{ id: string }>("SELECT id FROM projects WHERE org_id = $1", [orgId])
    : await q.query<{ id: string }>("SELECT p.id FROM projects p JOIN project_memberships m ON m.project_id = p.id AND m.user_id = $2 WHERE p.org_id = $1 AND m.role IN ('manager','contributor','viewer')", [orgId, userId]);
  return rows.map((r) => r.id);
}

export async function runReport(q: Queryable, dataset: string, cfg: ReportConfig, projectIds: string[]) {
  const ds = DATASETS[dataset];
  if (!ds) throw new HttpError(400, "Unknown dataset");
  const all: Record<string, ColumnDef> = { project: PROJECT_COLUMN, ...ds.columns };
  for (const c of [...cfg.columns, cfg.groupBy, cfg.sumColumn, cfg.sort].filter((x): x is string => !!x)) {
    if (!all[c]) throw new HttpError(400, `Unknown column "${c}" for ${ds.label}`);
  }
  for (const s of cfg.statuses) if (!ds.statuses.includes(s)) throw new HttpError(400, `Unknown status "${s}" for ${ds.label}`);
  if (cfg.sumColumn && !["number", "money"].includes(all[cfg.sumColumn]!.type)) throw new HttpError(400, "Only number or money columns can be totalled");
  if (cfg.assigneeId && !ds.assigneeColumn) throw new HttpError(400, `${ds.label} cannot be filtered by assignee`);
  if (cfg.from && cfg.to && cfg.from > cfg.to) throw new HttpError(400, "The date range ends before it starts");
  if (!projectIds.length) return { columns: cfg.columns.map((k) => ({ key: k, ...all[k]! })), rows: [], groups: null, total: null, truncated: false };

  const select = [...new Set([...cfg.columns, ...(cfg.groupBy ? [cfg.groupBy] : []), ...(cfg.sumColumn ? [cfg.sumColumn] : [])])];
  const params: unknown[] = [projectIds];
  const where = ["t.project_id = ANY($1::uuid[])"];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (cfg.statuses.length) where.push(`${ds.columns.status?.sql ?? ds.columns.log_status?.sql ?? "t.status"} = ANY(${bind(cfg.statuses)}::text[])`);
  if (cfg.from) where.push(`${ds.dateColumn} >= ${bind(cfg.from)}::date`);
  if (cfg.to) where.push(`${ds.dateColumn} <= ${bind(cfg.to)}::date`);
  if (cfg.text) where.push(`${ds.textColumn} ILIKE ${bind(`%${cfg.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)} ESCAPE '\\'`);
  if (cfg.assigneeId) where.push(`${ds.assigneeColumn} = ${bind(cfg.assigneeId)}`);
  const order = cfg.sort ? `${all[cfg.sort]!.sql} ${cfg.sortDesc ? "DESC" : "ASC"} NULLS LAST` : `${ds.dateColumn} DESC`;
  const LIMIT = 5000;
  const rows = await q.query<Record<string, unknown>>(
    `SELECT ${select.map((k) => `${all[k]!.sql} AS "${k}"`).join(", ")}
       FROM ${ds.from} JOIN projects p ON p.id = t.project_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}, p.name
      LIMIT ${LIMIT + 1}`,
    params,
  );
  const truncated = rows.length > LIMIT;
  if (truncated) rows.pop();
  const money = (k: string) => all[k]!.type === "money";
  const out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && money(k) ? fmt(dec(String(v))) : v])));
  let groups: { key: string; count: number; total: string | null }[] | null = null;
  if (cfg.groupBy) {
    const m = new Map<string, Record<string, unknown>[]>();
    for (const r of out) {
      const key = r[cfg.groupBy] === null || r[cfg.groupBy] === undefined ? "—" : String(r[cfg.groupBy]);
      m.set(key, [...(m.get(key) ?? []), r]);
    }
    groups = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, rs]) => ({
      key, count: rs.length, total: cfg.sumColumn ? fmt(sum(rs.map((r) => String(r[cfg.sumColumn!] ?? 0)))) : null,
    }));
  }
  const total = cfg.sumColumn ? fmt(sum(out.map((r) => String(r[cfg.sumColumn!] ?? 0)))) : null;
  return { columns: cfg.columns.map((k) => ({ key: k, label: all[k]!.label, type: all[k]!.type })), rows: out, groups, total, truncated };
}

export const reportRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  app.get("/reports/datasets", async (req) => {
    requireUser(req);
    return Object.entries(DATASETS).map(([key, d]) => ({
      key, label: d.label, statuses: d.statuses, canFilterAssignee: !!d.assigneeColumn,
      columns: Object.entries({ project: PROJECT_COLUMN, ...d.columns }).map(([k, c]) => ({ key: k, label: c.label, type: c.type })),
    }));
  });

  /** Scope: one project (must be fully readable) or every readable project in the company. */
  async function scope(userId: string, orgId: string, projectId: string | null | undefined) {
    if (projectId) {
      const access = await requireProject(db, userId, projectId, "read.full");
      if (access.project.org_id !== orgId) throw new HttpError(404, "Project not found");
      return [projectId];
    }
    return readableProjects(db, userId, orgId);
  }

  /** Projects whose permission template hides this dataset's tool from the caller are left out. */
  async function allowed(userId: string, dataset: string, projectIds: string[]) {
    const tool = DATASET_TOOL[dataset];
    if (!tool) return projectIds;
    const out: string[] = [];
    for (const p of projectIds) if ((await toolLevels(db, userId, p))[tool] !== "none") out.push(p);
    return out;
  }

  const runBody = z.object({ dataset: datasetKey, projectId: z.uuid().nullable().optional(), config: reportConfig });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/reports/run", async (req) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    const b = runBody.parse(req.body);
    return runReport(db, b.dataset, b.config, await allowed(user.id, b.dataset, await scope(user.id, req.params.orgId, b.projectId)));
  });

  // ---------- Saved reports ----------

  app.get<{ Params: { orgId: string } }>("/orgs/:orgId/reports", async (req) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    const readable = new Set(await readableProjects(db, user.id, req.params.orgId));
    const rows = await db.query<{ project_id: string | null }>(
      `SELECT r.id, r.name, r.dataset, r.project_id, p.name AS project_name, r.shared, r.created_by, u.name AS created_by_name, r.updated_at
         FROM saved_reports r LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN users u ON u.id = r.created_by
        WHERE r.org_id = $1 AND (r.shared OR r.created_by = $2) ORDER BY r.name`,
      [req.params.orgId, user.id],
    );
    return rows.filter((r) => !r.project_id || readable.has(r.project_id));
  });

  const saveBody = z.object({ name: z.string().trim().min(1).max(200), dataset: datasetKey, projectId: z.uuid().nullable().optional(), config: reportConfig, shared: z.boolean().default(false) });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/reports", async (req, reply) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    const b = saveBody.parse(req.body);
    await scope(user.id, req.params.orgId, b.projectId);
    await runReport(db, b.dataset, b.config, []); // validates the configuration
    const row = await db.tx(async (q) => {
      const [r] = await q.query<{ id: string }>(
        "INSERT INTO saved_reports (org_id, project_id, name, dataset, config, shared, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [req.params.orgId, b.projectId ?? null, b.name, b.dataset, JSON.stringify(b.config), b.shared, user.id],
      );
      await audit(q, { orgId: req.params.orgId, projectId: b.projectId ?? null, actorId: user.id, action: "report.save", entityType: "report", entityId: r!.id, detail: { name: b.name, dataset: b.dataset } });
      return r!;
    });
    return reply.code(201).send(row);
  });

  async function loadReport(id: string, userId: string) {
    if (!isUuid(id)) throw new HttpError(404, "Report not found");
    const [r] = await db.query<{ id: string; org_id: string; project_id: string | null; name: string; dataset: string; config: ReportConfig; shared: boolean; created_by: string | null }>("SELECT * FROM saved_reports WHERE id = $1", [id]);
    if (!r || !(await getOrgRole(db, userId, r.org_id)) || (!r.shared && r.created_by !== userId)) throw new HttpError(404, "Report not found");
    return r;
  }

  app.get<{ Params: { id: string } }>("/reports/:id", async (req) => {
    const user = requireUser(req);
    const r = await loadReport(req.params.id, user.id);
    const result = await runReport(db, r.dataset, reportConfig.parse(r.config), await allowed(user.id, r.dataset, await scope(user.id, r.org_id, r.project_id)));
    return { ...r, result, mine: r.created_by === user.id };
  });

  app.get<{ Params: { id: string } }>("/reports/:id/csv", async (req, reply) => {
    const user = requireUser(req);
    const r = await loadReport(req.params.id, user.id);
    const res = await runReport(db, r.dataset, reportConfig.parse(r.config), await allowed(user.id, r.dataset, await scope(user.id, r.org_id, r.project_id)));
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${r.name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "report"}.csv"`);
    return toCsv(res.columns.map((c) => c.label), res.rows.map((row) => res.columns.map((c) => {
      const v = row[c.key];
      return v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
    })));
  });

  app.patch<{ Params: { id: string } }>("/reports/:id", async (req) => {
    const user = requireUser(req);
    const r = await loadReport(req.params.id, user.id);
    const role = await getOrgRole(db, user.id, r.org_id);
    if (r.created_by !== user.id && role !== "owner" && role !== "admin") throw new HttpError(403, "Only the author or a company admin can change this report");
    const b = z.object({ name: z.string().trim().min(1).max(200).optional(), config: reportConfig.optional(), shared: z.boolean().optional() }).parse(req.body);
    if (b.config) await runReport(db, r.dataset, b.config, []);
    await db.tx(async (q) => {
      await q.query(
        "UPDATE saved_reports SET name = coalesce($2, name), config = coalesce($3::jsonb, config), shared = coalesce($4, shared), updated_at = now() WHERE id = $1",
        [r.id, b.name ?? null, b.config ? JSON.stringify(b.config) : null, b.shared ?? null],
      );
      await audit(q, { orgId: r.org_id, projectId: r.project_id, actorId: user.id, action: "report.update", entityType: "report", entityId: r.id });
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/reports/:id", async (req) => {
    const user = requireUser(req);
    const r = await loadReport(req.params.id, user.id);
    const role = await getOrgRole(db, user.id, r.org_id);
    if (r.created_by !== user.id && role !== "owner" && role !== "admin") throw new HttpError(403, "Only the author or a company admin can delete this report");
    await db.tx(async (q) => {
      await q.query("DELETE FROM saved_reports WHERE id = $1", [r.id]);
      await audit(q, { orgId: r.org_id, projectId: r.project_id, actorId: user.id, action: "report.delete", entityType: "report", entityId: r.id, detail: { name: r.name } });
    });
    return { ok: true };
  });

};
