import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { toCsv } from "../lib/finance.js";
import { D, dec, fmt } from "../lib/money.js";
import { assertVisibleToSub, canWriteRecords, isSubcontractor, projectRoleAllows, requireProject } from "../lib/permissions.js";
import { assertProjectMember, loadInProject, toSet, editable } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const date = z.iso.date();

/** Standard closeout checklist (CSI 01 77 00 / 01 78 00 deliverables). */
export const CLOSEOUT_TEMPLATE: { section: string; title: string; requiresFile?: boolean }[] = [
  { section: "Documents", title: "Operation and maintenance manuals", requiresFile: true },
  { section: "Documents", title: "As-built / record drawings", requiresFile: true },
  { section: "Documents", title: "Warranties and guarantees", requiresFile: true },
  { section: "Documents", title: "Final test and balance report", requiresFile: true },
  { section: "Documents", title: "Attic stock / spare parts transmittal", requiresFile: true },
  { section: "Inspections", title: "Punch list complete" },
  { section: "Inspections", title: "Final inspections by authorities having jurisdiction", requiresFile: true },
  { section: "Inspections", title: "Certificate of occupancy", requiresFile: true },
  { section: "Financial", title: "Final lien waivers from all subcontractors", requiresFile: true },
  { section: "Financial", title: "Consent of surety to final payment", requiresFile: true },
  { section: "Financial", title: "Retainage release requested" },
  { section: "Handover", title: "Owner training sessions held" },
  { section: "Handover", title: "Keys, access cards and codes turned over" },
  { section: "Handover", title: "Final cleaning complete" },
];

const itemInput = z.object({
  section: z.string().trim().min(1).max(100).default("General"),
  title: z.string().trim().min(1).max(300),
  assigneeId: z.uuid().nullable().optional(),
  dueDate: date.nullable().optional(),
  requiresFile: z.boolean().default(false),
});

export const closeoutRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  // ---------- Action plans ----------

  app.get<P>("/projects/:projectId/action-plans", async (req) => {
    const user = requireUser(req);
    const access = await requireProject(db, user.id, req.params.projectId, "read");
    const sub = isSubcontractor(access);
    return db.query(
      `SELECT p.id, p.title, p.kind, p.created_at,
              count(i.id) FILTER (WHERE NOT $2 OR i.assignee_id = $3)::int AS items,
              count(i.id) FILTER (WHERE i.status <> 'open' AND (NOT $2 OR i.assignee_id = $3))::int AS complete,
              count(i.id) FILTER (WHERE i.status = 'open' AND i.due_date < current_date AND (NOT $2 OR i.assignee_id = $3))::int AS overdue
         FROM action_plans p LEFT JOIN action_plan_items i ON i.plan_id = p.id
        WHERE p.project_id = $1
        GROUP BY p.id
       HAVING NOT $2 OR count(i.id) FILTER (WHERE i.assignee_id = $3) > 0
        ORDER BY p.created_at DESC`,
      [req.params.projectId, sub, user.id],
    );
  });

  async function insertItems(q: Queryable, projectId: string, planId: string, items: z.infer<typeof itemInput>[]) {
    const [m] = await q.query<{ n: number }>("SELECT coalesce(max(seq), 0)::int AS n FROM action_plan_items WHERE plan_id = $1", [planId]);
    let seq = m!.n;
    for (const it of items) {
      if (it.assigneeId) await assertProjectMember(q, projectId, it.assigneeId);
      await q.query(
        "INSERT INTO action_plan_items (plan_id, project_id, section, seq, title, assignee_id, due_date, requires_file) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [planId, projectId, it.section, ++seq, it.title, it.assigneeId ?? null, it.dueDate ?? null, it.requiresFile],
      );
    }
  }

  app.post<P>("/projects/:projectId/action-plans", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({
      title: z.string().trim().min(1).max(200),
      kind: z.enum(["closeout", "quality", "safety", "commissioning", "general"]).default("general"),
      description: optText(5000),
      items: z.array(itemInput).max(500).default([]),
      useCloseoutTemplate: z.boolean().default(false),
      copyFromPlanId: z.uuid().optional(),
    }).parse(req.body);
    const plan = await db.tx(async (q) => {
      let items = b.items;
      if (b.useCloseoutTemplate) items = [...CLOSEOUT_TEMPLATE.map((t) => ({ section: t.section, title: t.title, requiresFile: !!t.requiresFile })), ...items];
      if (b.copyFromPlanId) {
        const src = await q.query<{ section: string; title: string; requires_file: boolean }>(
          "SELECT i.section, i.title, i.requires_file FROM action_plan_items i JOIN action_plans p ON p.id = i.plan_id WHERE p.id = $1 AND p.project_id IN (SELECT id FROM projects WHERE org_id = $2) ORDER BY i.seq",
          [b.copyFromPlanId, project.org_id],
        );
        if (!src.length && !(await q.query("SELECT 1 FROM action_plans p JOIN projects pr ON pr.id = p.project_id WHERE p.id = $1 AND pr.org_id = $2", [b.copyFromPlanId, project.org_id])).length) {
          throw new HttpError(400, "Plan to copy was not found");
        }
        items = [...src.map((s) => ({ section: s.section, title: s.title, requiresFile: s.requires_file })), ...items];
      }
      const [p] = await q.query<{ id: string }>(
        "INSERT INTO action_plans (project_id, title, kind, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [project.id, b.title, b.kind, b.description ?? null, user.id],
      );
      await insertItems(q, project.id, p!.id, items);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "action_plan.create", entityType: "action_plan", entityId: p!.id, detail: { title: b.title, items: items.length } });
      const assignees = [...new Set(items.map((i) => i.assigneeId).filter((x): x is string => !!x))];
      await config.notify(q, assignees, { kind: "action_plan", title: `You have items in "${b.title}"`, link: `/action-plans/${p!.id}`, projectId: project.id, actorId: user.id });
      return p!;
    });
    return reply.code(201).send(plan);
  });

  async function planDetail(planId: string, userId: string, sub: boolean) {
    const [plan] = await db.query<Record<string, unknown>>("SELECT p.*, u.name AS created_by_name FROM action_plans p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1", [planId]);
    const items = await db.query<{ status: string }>(
      `SELECT i.id, i.section, i.seq, i.title, i.assignee_id, a.name AS assignee_name, i.due_date, i.requires_file, i.status, i.notes,
              c.name AS completed_by_name, i.completed_at,
              (SELECT count(*)::int FROM attachments x WHERE x.entity_type = 'action_plan_item' AND x.entity_id = i.id) AS files
         FROM action_plan_items i LEFT JOIN users a ON a.id = i.assignee_id LEFT JOIN users c ON c.id = i.completed_by
        WHERE i.plan_id = $1 AND (NOT $2 OR i.assignee_id = $3) ORDER BY i.seq`,
      [planId, sub, userId],
    );
    const complete = items.filter((i) => i.status !== "open").length;
    return { ...plan, items, progress: { complete, total: items.length, percent: items.length ? Math.floor((complete * 100) / items.length) : 0 } };
  }

  app.get<Id>("/action-plans/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "action_plans", req.params.id, user.id, "read", "Action plan");
    const sub = isSubcontractor(access);
    const d = await planDetail(row.id, user.id, sub);
    if (sub && !d.items.length) throw new HttpError(404, "Action plan not found");
    return { ...d, myRole: access.role, myId: user.id };
  });

  app.post<Id>("/action-plans/:id/items", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "action_plans", req.params.id, user.id, "record.write", "Action plan");
    const items = z.array(itemInput).min(1).max(200).parse(req.body);
    await db.tx(async (q) => {
      await insertItems(q, row.project_id, row.id, items);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "action_plan.items_add", entityType: "action_plan", entityId: row.id, detail: { items: items.length } });
    });
    return reply.code(201).send({ ok: true });
  });

  /** Assignees complete their own items; writers edit any item. "Done" on a file-required item needs an attachment. */
  app.patch<Id>("/action-plan-items/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; plan_id: string; assignee_id: string | null; requires_file: boolean; status: string }>(db, "action_plan_items", req.params.id, user.id, "read", "Item");
    assertVisibleToSub(access, user.id, [row.assignee_id], "Item");
    const writer = canWriteRecords(access.role);
    if (!writer && row.assignee_id !== user.id) throw new HttpError(403, "Only the assignee or the project team can update this item");
    const b = z.object({
      status: z.enum(["open", "done", "not_applicable"]).optional(),
      notes: optText(5000),
      assigneeId: z.uuid().nullable().optional(),
      dueDate: date.nullable().optional(),
      title: z.string().trim().min(1).max(300).optional(),
    }).parse(req.body);
    if (!writer && (b.assigneeId !== undefined || b.dueDate !== undefined || b.title !== undefined)) throw new HttpError(403, "Only the project team can reassign or reschedule items");
    if (b.status === "not_applicable" && !projectRoleAllows(access.role, "record.manage")) throw new HttpError(403, "Only a project manager can mark an item not applicable");
    if (b.status === "done" && row.requires_file) {
      const [f] = await db.query("SELECT 1 FROM attachments WHERE entity_type = 'action_plan_item' AND entity_id = $1", [row.id]);
      if (!f) throw new HttpError(400, "Attach the required document before completing this item");
    }
    await db.tx(async (q) => {
      if (b.assigneeId) await assertProjectMember(q, row.project_id, b.assigneeId);
      const { sets, values } = toSet(b, { notes: "notes", assigneeId: "assignee_id", dueDate: "due_date", title: "title" });
      if (b.status) {
        values.push(b.status);
        sets.push(`status = $${values.length + 1}`);
        values.push(b.status === "open" ? null : user.id);
        sets.push(`completed_by = $${values.length + 1}`, `completed_at = ${b.status === "open" ? "NULL" : "now()"}`);
      }
      if (sets.length) await q.query(`UPDATE action_plan_items SET ${sets.join(", ")} WHERE id = $1`, [row.id, ...values]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "action_plan.item_update", entityType: "action_plan", entityId: row.plan_id, detail: { item: row.id, ...b } });
      if (b.assigneeId && b.assigneeId !== row.assignee_id) {
        await config.notify(q, [b.assigneeId], { kind: "action_plan", title: "An action plan item was assigned to you", link: `/action-plans/${row.plan_id}`, projectId: row.project_id, actorId: user.id });
      }
    });
    return { ok: true };
  });

  app.get<Id>("/action-plan-items/:id/files", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; assignee_id: string | null }>(db, "action_plan_items", req.params.id, user.id, "read", "Item");
    assertVisibleToSub(access, user.id, [row.assignee_id], "Item");
    return db.query(`SELECT f.id, f.name, f.mime, f.size FROM attachments a JOIN files f ON f.id = a.file_id WHERE a.entity_type = 'action_plan_item' AND a.entity_id = $1 ORDER BY a.created_at`, [row.id]);
  });

  // ---------- Warranties ----------

  const warrantyInput = z.object({
    item: z.string().trim().min(1).max(300),
    company: z.string().trim().min(1).max(200),
    specSection: optText(50),
    startDate: date,
    endDate: date,
    contact: optText(300),
    notes: optText(5000),
  });

  app.get<P>("/projects/:projectId/warranties", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT w.id, w.item, w.company, w.spec_section, w.start_date, w.end_date, w.contact, w.notes,
              CASE WHEN w.end_date < current_date THEN 'expired' WHEN w.end_date < current_date + 60 THEN 'expiring' ELSE 'active' END AS state,
              (SELECT count(*)::int FROM attachments a WHERE a.entity_type = 'warranty' AND a.entity_id = w.id) AS files
         FROM warranties w WHERE w.project_id = $1 ORDER BY w.end_date, w.item`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/warranties", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = warrantyInput.parse(req.body);
    if (b.endDate < b.startDate) throw new HttpError(400, "The warranty cannot end before it starts");
    const row = await db.tx(async (q) => {
      const [w] = await q.query<{ id: string }>(
        "INSERT INTO warranties (project_id, item, company, spec_section, start_date, end_date, contact, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
        [project.id, b.item, b.company, b.specSection ?? null, b.startDate, b.endDate, b.contact ?? null, b.notes ?? null, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "warranty.create", entityType: "warranty", entityId: w!.id, detail: { item: b.item } });
      return w!;
    });
    return reply.code(201).send(row);
  });

  app.get<Id>("/warranties/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "warranties", req.params.id, user.id, "read.full", "Warranty");
    const files = await db.query(`SELECT f.id, f.name, f.mime, f.size FROM attachments a JOIN files f ON f.id = a.file_id WHERE a.entity_type = 'warranty' AND a.entity_id = $1 ORDER BY a.created_at`, [row.id]);
    return { ...row, files, myRole: access.role };
  });

  app.patch<Id>("/warranties/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; start_date: string; end_date: string }>(db, "warranties", req.params.id, user.id, "record.write", "Warranty");
    const b = editable(warrantyInput).parse(req.body);
    if ((b.endDate ?? row.end_date) < (b.startDate ?? row.start_date)) throw new HttpError(400, "The warranty cannot end before it starts");
    const { sets, values } = toSet(b, { item: "item", company: "company", specSection: "spec_section", startDate: "start_date", endDate: "end_date", contact: "contact", notes: "notes" });
    if (sets.length) {
      await db.tx(async (q) => {
        await q.query(`UPDATE warranties SET ${sets.join(", ")} WHERE id = $1`, [row.id, ...values]);
        await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "warranty.update", entityType: "warranty", entityId: row.id, detail: b });
      });
    }
    return { ok: true };
  });

  // ---------- Coordination issues ----------

  // Edits use the fields without defaults, so a partial PATCH never resets type or priority.
  const issueFields = z.object({
    title: z.string().trim().min(1).max(300),
    description: optText(10000),
    type: z.enum(["clash", "design", "constructability", "missing_information", "other"]),
    priority: z.enum(["low", "medium", "high"]),
    assigneeId: z.uuid().nullable().optional(),
    dueDate: date.nullable().optional(),
    location: optText(300),
  });
  const issueInput = issueFields.extend({ type: issueFields.shape.type.default("clash"), priority: issueFields.shape.priority.default("medium") });

  app.get<P>("/projects/:projectId/coordination-issues", async (req) => {
    const user = requireUser(req);
    const access = await requireProject(db, user.id, req.params.projectId, "read");
    const sub = isSubcontractor(access);
    return db.query(
      `SELECT i.id, i.number, i.title, i.type, i.priority, i.status, i.due_date, i.location, i.assignee_id, a.name AS assignee_name,
              jsonb_array_length(i.elements) AS elements, i.clash_run_id
         FROM coordination_issues i LEFT JOIN users a ON a.id = i.assignee_id
        WHERE i.project_id = $1 AND (NOT $2 OR $3 IN (i.assignee_id, i.created_by))
        ORDER BY i.number DESC`,
      [req.params.projectId, sub, user.id],
    );
  });

  async function createIssue(q: Queryable, projectId: string, orgId: string, userId: string, b: z.infer<typeof issueInput>, extra: { clashRunId?: string; elements?: unknown[] } = {}) {
    if (b.assigneeId) await assertProjectMember(q, projectId, b.assigneeId);
    await q.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
    const [n] = await q.query<{ n: number }>("SELECT coalesce(max(number), 0)::int + 1 AS n FROM coordination_issues WHERE project_id = $1", [projectId]);
    const [i] = await q.query<{ id: string; number: number }>(
      `INSERT INTO coordination_issues (project_id, number, title, description, type, priority, assignee_id, due_date, location, clash_run_id, elements, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, number`,
      [projectId, n!.n, b.title, b.description ?? null, b.type, b.priority, b.assigneeId ?? null, b.dueDate ?? null, b.location ?? null, extra.clashRunId ?? null, JSON.stringify(extra.elements ?? []), userId],
    );
    await audit(q, { orgId, projectId, actorId: userId, action: "coordination_issue.create", entityType: "coordination_issue", entityId: i!.id, detail: { number: n!.n, title: b.title } });
    if (b.assigneeId) await config.notify(q, [b.assigneeId], { kind: "coordination_issue", title: `Coordination issue #${n!.n}: ${b.title}`, link: `/coordination-issues/${i!.id}`, projectId, actorId: userId });
    return i!;
  }

  app.post<P>("/projects/:projectId/coordination-issues", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = issueInput.parse(req.body);
    const row = await db.tx((q) => createIssue(q, project.id, project.org_id, user.id, b));
    return reply.code(201).send(row);
  });

  /** One issue per clash, titled from the two elements; already-raised clashes are skipped. */
  app.post<{ Params: { id: string } }>("/clash-runs/:id/issues", async (req, reply) => {
    const user = requireUser(req);
    const b = z.object({ indexes: z.array(z.number().int().min(0)).min(1).max(500), assigneeId: z.uuid().nullable().optional(), priority: z.enum(["low", "medium", "high"]).default("medium") }).parse(req.body);
    const { row, access } = await loadInProject<{ id: string; project_id: string; results: { a: { id: string; type: string; name: string | null }; b: { id: string; type: string; name: string | null }; kind?: string; distanceM?: number }[] }>(db, "clash_runs", req.params.id, user.id, "record.write", "Clash run");
    const created = await db.tx(async (q) => {
      const out: { id: string; number: number }[] = [];
      const existing = await q.query<{ elements: { id: string }[] }>("SELECT elements FROM coordination_issues WHERE clash_run_id = $1", [row.id]);
      const raised = new Set(existing.map((e) => e.elements.map((x) => x.id).sort().join("|")));
      for (const ix of new Set(b.indexes)) {
        const c = row.results[ix];
        if (!c) throw new HttpError(400, `Clash ${ix + 1} does not exist in this run`);
        const key = [c.a.id, c.b.id].sort().join("|");
        if (raised.has(key)) continue;
        raised.add(key);
        const name = (e: { type: string; name: string | null }) => `${e.name ?? "unnamed"} (${e.type.replace(/^Ifc/i, "")})`;
        const what = c.kind === "clearance" ? `clearance ${Math.round((c.distanceM ?? 0) * 1000)} mm` : "hard clash";
        out.push(await createIssue(q, row.project_id, access.project.org_id, user.id, {
          title: `${name(c.a)} × ${name(c.b)}`, description: `From clash run: ${what}.`, type: "clash", priority: b.priority, assigneeId: b.assigneeId ?? null,
        }, { clashRunId: row.id, elements: [c.a, c.b] }));
      }
      return out;
    });
    return reply.code(201).send({ created: created.length, issues: created });
  });

  app.get<Id>("/coordination-issues/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; assignee_id: string | null; created_by: string | null }>(db, "coordination_issues", req.params.id, user.id, "read", "Coordination issue");
    assertVisibleToSub(access, user.id, [row.assignee_id, row.created_by], "Coordination issue");
    const [d] = await db.query(`SELECT i.*, a.name AS assignee_name, c.name AS created_by_name FROM coordination_issues i LEFT JOIN users a ON a.id = i.assignee_id LEFT JOIN users c ON c.id = i.created_by WHERE i.id = $1`, [row.id]);
    const files = await db.query(`SELECT f.id, f.name, f.mime, f.size FROM attachments a JOIN files f ON f.id = a.file_id WHERE a.entity_type = 'coordination_issue' AND a.entity_id = $1 ORDER BY a.created_at`, [row.id]);
    return { ...d, files, myRole: access.role, myId: user.id };
  });

  /** Workflow: open → in progress → ready for review (assignee) → closed (manager or creator); anyone with write access may reopen. */
  app.patch<Id>("/coordination-issues/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; assignee_id: string | null; created_by: string | null; status: string }>(db, "coordination_issues", req.params.id, user.id, "read", "Coordination issue");
    assertVisibleToSub(access, user.id, [row.assignee_id, row.created_by], "Coordination issue");
    const b = editable(issueFields).extend({ status: z.enum(["open", "in_progress", "ready_for_review", "closed"]).optional() }).parse(req.body);
    const writer = canWriteRecords(access.role);
    const assignee = row.assignee_id === user.id;
    const { status, ...fields } = b;
    if (Object.keys(fields).length && !writer) throw new HttpError(403, "Only the project team can edit this issue");
    if (status) {
      if (status === "closed" && !(projectRoleAllows(access.role, "record.manage") || row.created_by === user.id)) throw new HttpError(403, "Only a project manager or the issue's author can close it");
      if ((status === "in_progress" || status === "ready_for_review") && !(assignee || writer)) throw new HttpError(403, "Only the assignee can progress this issue");
      if (status === "open" && !writer) throw new HttpError(403, "Only the project team can reopen this issue");
    }
    await db.tx(async (q) => {
      if (fields.assigneeId) await assertProjectMember(q, row.project_id, fields.assigneeId);
      const { sets, values } = toSet(b, { title: "title", description: "description", type: "type", priority: "priority", assigneeId: "assignee_id", dueDate: "due_date", location: "location", status: "status" });
      if (status) sets.push(`closed_at = ${status === "closed" ? "now()" : "NULL"}`);
      if (sets.length) await q.query(`UPDATE coordination_issues SET ${sets.join(", ")} WHERE id = $1`, [row.id, ...values]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: status ? `coordination_issue.${status}` : "coordination_issue.update", entityType: "coordination_issue", entityId: row.id, detail: b });
      if (fields.assigneeId && fields.assigneeId !== row.assignee_id) {
        await config.notify(q, [fields.assigneeId], { kind: "coordination_issue", title: "A coordination issue was assigned to you", link: `/coordination-issues/${row.id}`, projectId: row.project_id, actorId: user.id });
      }
      if (status === "ready_for_review" && row.created_by && row.created_by !== user.id) {
        await config.notify(q, [row.created_by], { kind: "coordination_issue", title: "A coordination issue is ready for review", link: `/coordination-issues/${row.id}`, projectId: row.project_id, actorId: user.id });
      }
    });
    return { ok: true };
  });

  // ---------- Payroll export ----------

  /**
   * Approved hours per worker for a pay period, with weekly overtime: hours past 40 in a Monday-to-Sunday week
   * (across this project) are overtime, assigned to the latest entries of that week.
   */
  async function payrollRows(projectId: string, from: string, to: string) {
    const entries = await db.query<{ id: string; work_date: string; hours: string; worker: string; email: string; user_id: string; cost_code: string | null; exported_at: string | null }>(
      `SELECT t.id, t.work_date, t.hours::text, u.name AS worker, u.email, t.user_id, c.code AS cost_code, t.exported_at
         FROM timesheet_entries t JOIN users u ON u.id = t.user_id LEFT JOIN cost_codes c ON c.id = t.cost_code_id
        WHERE t.project_id = $1 AND t.status = 'approved' AND t.work_date BETWEEN $2 AND $3
        ORDER BY u.name, t.user_id, t.work_date, t.created_at`,
      [projectId, from, to],
    );
    const weekOf = (d: string) => {
      const dt = new Date(`${d}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      return dt.toISOString().slice(0, 10);
    };
    const used = new Map<string, InstanceType<typeof D>>();
    return entries.map((e) => {
      const key = `${e.user_id}|${weekOf(e.work_date)}`;
      const before = used.get(key) ?? new D(0);
      const h = dec(e.hours);
      const regular = D.max(0, D.min(h, new D(40).minus(before)));
      used.set(key, before.plus(h));
      return { ...e, week_of: weekOf(e.work_date), regular: fmt(regular), overtime: fmt(h.minus(regular)), hours: fmt(h) };
    });
  }

  const period = z.object({ from: date, to: date }).refine((p) => p.from <= p.to, "The period must end after it starts");

  app.get<P & { Querystring: { from?: string; to?: string } }>("/projects/:projectId/timesheets/payroll", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const p = period.parse(req.query);
    const rows = await payrollRows(project.id, p.from, p.to);
    return { rows, alreadyExported: rows.filter((r) => r.exported_at).length };
  });

  app.get<P & { Querystring: { from?: string; to?: string } }>("/projects/:projectId/timesheets/payroll.csv", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const p = period.parse(req.query);
    const rows = await payrollRows(project.id, p.from, p.to);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="payroll-${p.from}-to-${p.to}.csv"`);
    return toCsv(["Employee", "Email", "Week of", "Date", "Cost code", "Hours", "Regular", "Overtime", "Previously exported"],
      rows.map((r) => [r.worker, r.email, r.week_of, r.work_date, r.cost_code ?? "", r.hours, r.regular, r.overtime, r.exported_at ? "yes" : ""]));
  });

  /** Marks the period's approved entries as sent to payroll so the next export can flag duplicates. */
  app.post<P>("/projects/:projectId/timesheets/mark-exported", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const p = period.parse(req.body);
    const n = await db.tx(async (q) => {
      const r = await q.query<{ id: string }>(
        "UPDATE timesheet_entries SET exported_at = now() WHERE project_id = $1 AND status = 'approved' AND exported_at IS NULL AND work_date BETWEEN $2 AND $3 RETURNING id",
        [project.id, p.from, p.to],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "timesheet.export", entityType: "project", entityId: project.id, detail: { from: p.from, to: p.to, entries: r.length } });
      return r.length;
    });
    return { marked: n };
  });
};
