import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { dec } from "../lib/money.js";
import { isUuid, projectRoleAllows, requireOrgRole, requireProject } from "../lib/permissions.js";
import { assertProjectMember, editable, loadInProject, toSet } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const hours = z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, "Hours must be a number with up to 2 decimals"));

const workerFields = z.object({
  name: z.string().trim().min(1).max(200),
  employeeNumber: optText(50),
  trade: optText(100),
  company: optText(200),
  active: z.boolean(),
});
const workerInput = workerFields.extend({ active: workerFields.shape.active.default(true) });
const workerCols = { name: "name", employeeNumber: "employee_number", trade: "trade", company: "company", active: "active" };

/** Field workers (no login) belong to the company; crews and crew time belong to a project. */
export const crewRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  async function insertWorker(q: Queryable, orgId: string, b: z.infer<typeof workerInput>) {
    if (b.employeeNumber && (await q.query("SELECT 1 FROM workers WHERE org_id = $1 AND lower(employee_number) = lower($2)", [orgId, b.employeeNumber])).length) {
      throw new HttpError(409, "Another worker already has that employee number");
    }
    const [w] = await q.query<{ id: string }>(
      "INSERT INTO workers (org_id, name, employee_number, trade, company, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name",
      [orgId, b.name, b.employeeNumber ?? null, b.trade ?? null, b.company ?? null, b.active],
    );
    return w!;
  }

  // ---------- Workers ----------

  app.get<{ Params: { orgId: string } }>("/orgs/:orgId/workers", async (req) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    return db.query("SELECT id, name, employee_number, trade, company, active FROM workers WHERE org_id = $1 ORDER BY active DESC, name", [req.params.orgId]);
  });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/workers", async (req, reply) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const b = workerInput.parse(req.body);
    const w = await db.tx(async (q) => {
      const row = await insertWorker(q, req.params.orgId, b);
      await audit(q, { orgId: req.params.orgId, actorId: user.id, action: "worker.create", entityType: "worker", entityId: row.id, detail: { name: b.name } });
      return row;
    });
    return reply.code(201).send(w);
  });

  /** Project managers can add a worker on the spot (e.g. a new laborer on site); it joins the company directory. */
  app.post<P>("/projects/:projectId/workers", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const b = workerInput.parse(req.body);
    const w = await db.tx(async (q) => {
      const row = await insertWorker(q, project.org_id, b);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "worker.create", entityType: "worker", entityId: row.id, detail: { name: b.name } });
      return row;
    });
    return reply.code(201).send(w);
  });

  app.patch<Id>("/workers/:id", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.id)) throw new HttpError(404, "Worker not found");
    const [w] = await db.query<{ id: string; org_id: string }>("SELECT id, org_id FROM workers WHERE id = $1", [req.params.id]);
    if (!w) throw new HttpError(404, "Worker not found");
    try {
      await requireOrgRole(db, user.id, w.org_id, ["owner", "admin"]);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new HttpError(404, "Worker not found");
      throw e;
    }
    const b = editable(workerFields).parse(req.body);
    const { sets, values } = toSet(b, workerCols);
    if (sets.length) {
      await db.tx(async (q) => {
        if (b.employeeNumber && (await q.query("SELECT 1 FROM workers WHERE org_id = $1 AND lower(employee_number) = lower($2) AND id <> $3", [w.org_id, b.employeeNumber, w.id])).length) {
          throw new HttpError(409, "Another worker already has that employee number");
        }
        await q.query(`UPDATE workers SET ${sets.join(", ")} WHERE id = $1`, [w.id, ...values]);
        await audit(q, { orgId: w.org_id, actorId: user.id, action: "worker.update", entityType: "worker", entityId: w.id, detail: b });
      });
    }
    return { ok: true };
  });

  // ---------- Crews ----------

  const crewFields = z.object({
    name: z.string().trim().min(1).max(100),
    foremanId: z.uuid().nullable().optional(),
    workerIds: z.array(z.uuid()).max(500),
  });

  async function setMembers(q: Queryable, orgId: string, crewId: string, workerIds: string[]) {
    const ids = [...new Set(workerIds)];
    if (ids.length) {
      const ok = await q.query<{ id: string }>("SELECT id FROM workers WHERE org_id = $1 AND id = ANY($2::uuid[])", [orgId, ids]);
      if (ok.length !== ids.length) throw new HttpError(400, "Unknown worker");
    }
    await q.query("DELETE FROM crew_members WHERE crew_id = $1", [crewId]);
    for (const w of ids) await q.query("INSERT INTO crew_members (crew_id, worker_id) VALUES ($1, $2)", [crewId, w]);
  }

  app.get<P>("/projects/:projectId/crews", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT c.id, c.name, c.foreman_id, f.name AS foreman_name,
              coalesce((SELECT json_agg(json_build_object('id', w.id, 'name', w.name, 'trade', w.trade, 'employee_number', w.employee_number, 'active', w.active) ORDER BY w.name)
                          FROM crew_members m JOIN workers w ON w.id = m.worker_id WHERE m.crew_id = c.id), '[]') AS members
         FROM crews c LEFT JOIN users f ON f.id = c.foreman_id WHERE c.project_id = $1 ORDER BY c.name`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/crews", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const b = crewFields.extend({ workerIds: crewFields.shape.workerIds.default([]) }).parse(req.body);
    const row = await db.tx(async (q) => {
      if (b.foremanId) await assertProjectMember(q, project.id, b.foremanId, "Foreman");
      if ((await q.query("SELECT 1 FROM crews WHERE project_id = $1 AND lower(name) = lower($2)", [project.id, b.name])).length) throw new HttpError(409, "A crew with that name already exists");
      const [c] = await q.query<{ id: string }>("INSERT INTO crews (project_id, name, foreman_id) VALUES ($1, $2, $3) RETURNING id", [project.id, b.name, b.foremanId ?? null]);
      await setMembers(q, project.org_id, c!.id, b.workerIds);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "crew.create", entityType: "crew", entityId: c!.id, detail: { name: b.name, members: b.workerIds.length } });
      return c!;
    });
    return reply.code(201).send(row);
  });

  app.patch<Id>("/crews/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "crews", req.params.id, user.id, "record.manage", "Crew");
    const b = editable(crewFields).parse(req.body);
    await db.tx(async (q) => {
      if (b.foremanId) await assertProjectMember(q, row.project_id, b.foremanId, "Foreman");
      const { sets, values } = toSet(b, { name: "name", foremanId: "foreman_id" });
      if (sets.length) await q.query(`UPDATE crews SET ${sets.join(", ")} WHERE id = $1`, [row.id, ...values]);
      if (b.workerIds) await setMembers(q, access.project.org_id, row.id, b.workerIds);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "crew.update", entityType: "crew", entityId: row.id, detail: b });
    });
    return { ok: true };
  });

  /**
   * A foreman (or project manager) enters a day's hours for their crew in one go. Entries go to the normal approval
   * queue; whoever entered them cannot approve them.
   */
  app.post<P>("/projects/:projectId/timesheets/crew", async (req, reply) => {
    const user = requireUser(req);
    const access = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({
      crewId: z.uuid(),
      workDate: z.iso.date(),
      costCodeId: z.uuid().nullable().optional(),
      description: optText(2000),
      entries: z.array(z.object({ workerId: z.uuid(), hours, costCodeId: z.uuid().nullable().optional() })).min(1).max(500),
    }).parse(req.body);
    if (b.workDate > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) throw new HttpError(400, "Cannot log future time");
    const result = await db.tx(async (q) => {
      const [crew] = await q.query<{ id: string; foreman_id: string | null; name: string }>("SELECT id, foreman_id, name FROM crews WHERE id = $1 AND project_id = $2", [b.crewId, access.project.id]);
      if (!crew) throw new HttpError(400, "Crew not found in this project");
      if (crew.foreman_id !== user.id && !projectRoleAllows(access.role, "record.manage")) throw new HttpError(403, "Only the crew's foreman or a project manager can enter crew time");
      const members = new Set((await q.query<{ worker_id: string }>("SELECT worker_id FROM crew_members WHERE crew_id = $1", [crew.id])).map((m) => m.worker_id));
      const codes = [...new Set([b.costCodeId, ...b.entries.map((e) => e.costCodeId)].filter((x): x is string => !!x))];
      if (codes.length && (await q.query("SELECT id FROM cost_codes WHERE project_id = $1 AND id = ANY($2::uuid[])", [access.project.id, codes])).length !== codes.length) throw new HttpError(400, "Unknown cost code");
      const perWorker = new Map<string, ReturnType<typeof dec>>();
      for (const e of b.entries) {
        if (!members.has(e.workerId)) throw new HttpError(400, "Everyone on the timesheet must be in the crew");
        if (dec(e.hours).lte(0) || dec(e.hours).gt(24)) throw new HttpError(400, "Hours must be between 0 and 24");
        perWorker.set(e.workerId, (perWorker.get(e.workerId) ?? dec(0)).plus(e.hours));
      }
      for (const [workerId, h] of perWorker) {
        const [day] = await q.query<{ h: string | null }>("SELECT sum(hours)::text AS h FROM timesheet_entries WHERE worker_id = $1 AND work_date = $2 AND status <> 'rejected'", [workerId, b.workDate]);
        if (dec(day?.h ?? 0).plus(h).gt(24)) throw new HttpError(400, "More than 24 hours on one day for a crew member");
      }
      const ids: string[] = [];
      for (const e of b.entries) {
        const [t] = await q.query<{ id: string }>(
          "INSERT INTO timesheet_entries (project_id, worker_id, work_date, cost_code_id, hours, description, entered_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
          [access.project.id, e.workerId, b.workDate, e.costCodeId ?? b.costCodeId ?? null, e.hours, b.description ?? null, user.id],
        );
        ids.push(t!.id);
      }
      await audit(q, { orgId: access.project.org_id, projectId: access.project.id, actorId: user.id, action: "timesheet.crew", entityType: "crew", entityId: crew.id, detail: { date: b.workDate, entries: ids.length } });
      return { created: ids.length };
    });
    return reply.code(201).send(result);
  });
};
