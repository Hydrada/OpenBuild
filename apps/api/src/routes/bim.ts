import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isIfc, summarizeIfc } from "../lib/ifc.js";
import { elementBoxes, findClashes } from "../lib/ifc-geometry.js";
import { requireProject } from "../lib/permissions.js";
import { loadInProject } from "../lib/records.js";
import { readUpload, storeFile } from "../lib/uploads.js";

type P = { Params: { projectId: string } };

/** BIM model register: IFC versions per model, with schema and element counts for change review. */
export const bimRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db, storage } = config;

  app.get<P>("/projects/:projectId/models", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT m.id, m.name, m.discipline, v.version, v.ifc_schema, v.element_counts, v.file_id, v.created_at, u.name AS uploaded_by_name
         FROM bim_models m JOIN LATERAL (SELECT * FROM bim_model_versions x WHERE x.model_id = m.id ORDER BY x.version DESC LIMIT 1) v ON true
         LEFT JOIN users u ON u.id = v.uploaded_by WHERE m.project_id = $1 ORDER BY m.discipline, m.name`,
      [req.params.projectId],
    );
  });

  /** Upload a model: a new name creates the model, an existing name adds the next version. */
  app.post<P>("/projects/:projectId/models", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const up = await readUpload(req);
    const f = z.object({ name: z.string().trim().min(1).max(200), discipline: z.string().trim().max(60).optional(), note: z.string().trim().max(2000).optional() }).parse(up.fields);
    if (!up.file) throw new HttpError(400, "Choose an IFC file");
    if (!isIfc(up.file.data)) throw new HttpError(400, "Models must be IFC (ISO-10303-21) files");
    const summary = summarizeIfc(up.file.data);
    const out = await db.tx(async (q) => {
      let [m] = await q.query<{ id: string }>("SELECT id FROM bim_models WHERE project_id = $1 AND name = $2 FOR UPDATE", [project.id, f.name]);
      if (!m) [m] = await q.query<{ id: string }>("INSERT INTO bim_models (project_id, name, discipline) VALUES ($1, $2, $3) RETURNING id", [project.id, f.name, f.discipline || "Architectural"]);
      const [n] = await q.query<{ n: number }>("SELECT coalesce(max(version), 0)::int + 1 AS n FROM bim_model_versions WHERE model_id = $1", [m!.id]);
      const file = await storeFile(q, storage, { orgId: project.org_id, projectId: project.id, userId: user.id, file: up.file! });
      await q.query(
        `INSERT INTO bim_model_versions (model_id, version, file_id, ifc_schema, element_counts, note, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [m!.id, n!.n, file.id, summary.schema, JSON.stringify(summary.counts), f.note || null, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "model.version", entityType: "bim_model", entityId: m!.id, detail: { name: f.name, version: n!.n, schema: summary.schema } });
      return { modelId: m!.id, version: n!.n, ...summary };
    });
    return reply.code(201).send(out);
  });

  async function readAll(key: string): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const c of await storage.get(key)) chunks.push(Buffer.from(c as Buffer));
    return new Uint8Array(Buffer.concat(chunks));
  }

  /**
   * Coarse clash detection between the latest versions of two models: element bounding boxes (from real
   * geometry) that overlap by more than the tolerance on every axis. Runs are stored for review.
   */
  app.post<P>("/projects/:projectId/clashes", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({ modelAId: z.uuid(), modelBId: z.uuid(), toleranceMm: z.number().min(0).max(1000).default(10) }).parse(req.body);
    if (b.modelAId === b.modelBId) throw new HttpError(400, "Choose two different models");
    const latest = async (modelId: string) => {
      const [v] = await db.query<{ id: string; storage_key: string; name: string; version: number }>(
        `SELECT v.id, f.storage_key, m.name, v.version FROM bim_models m JOIN bim_model_versions v ON v.model_id = m.id JOIN files f ON f.id = v.file_id
          WHERE m.id = $1 AND m.project_id = $2 ORDER BY v.version DESC LIMIT 1`,
        [modelId, project.id],
      );
      if (!v) throw new HttpError(404, "Model not found");
      return v;
    };
    const [va, vb] = [await latest(b.modelAId), await latest(b.modelBId)];
    let clashes;
    try {
      clashes = findClashes(await elementBoxes(await readAll(va.storage_key)), await elementBoxes(await readAll(vb.storage_key)), b.toleranceMm / 1000);
    } catch (e) {
      throw new HttpError(422, `The model geometry could not be read: ${(e as Error).message}`);
    }
    const results = clashes.map((c) => ({
      a: { id: c.a.globalId, type: c.a.type, name: c.a.name }, b: { id: c.b.globalId, type: c.b.type, name: c.b.name },
      overlapM: c.overlap, volumeM3: c.volume, exact: c.exact,
    }));
    const [run] = await db.tx(async (q) => {
      const r = await q.query<{ id: string }>(
        `INSERT INTO clash_runs (project_id, version_a, version_b, tolerance_m, clash_count, results, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [project.id, va.id, vb.id, b.toleranceMm / 1000, results.length, JSON.stringify(results), user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "model.clash_run", entityType: "project", entityId: project.id, detail: { a: `${va.name} v${va.version}`, b: `${vb.name} v${vb.version}`, clashes: results.length } });
      return r;
    });
    return reply.code(201).send({ id: run!.id, a: `${va.name} v${va.version}`, b: `${vb.name} v${vb.version}`, clashCount: results.length, clashes: results });
  });

  app.get<P>("/projects/:projectId/clashes", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT r.id, r.created_at, r.clash_count, r.tolerance_m::text, r.results, ma.name || ' v' || va.version AS model_a, mb.name || ' v' || vb.version AS model_b, u.name AS run_by
         FROM clash_runs r JOIN bim_model_versions va ON va.id = r.version_a JOIN bim_models ma ON ma.id = va.model_id
         JOIN bim_model_versions vb ON vb.id = r.version_b JOIN bim_models mb ON mb.id = vb.model_id LEFT JOIN users u ON u.id = r.created_by
        WHERE r.project_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
      [req.params.projectId],
    );
  });

  /** Version history with element-count changes against the previous version. */
  app.get<{ Params: { id: string } }>("/models/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "bim_models", req.params.id, user.id, "read", "Model");
    const versions = await db.query<{ version: number; element_counts: Record<string, number> }>(
      `SELECT v.id, v.version, v.ifc_schema, v.element_counts, v.file_id, v.note, v.created_at, u.name AS uploaded_by_name, f.size
         FROM bim_model_versions v JOIN files f ON f.id = v.file_id LEFT JOIN users u ON u.id = v.uploaded_by
        WHERE v.model_id = $1 ORDER BY v.version DESC`,
      [row.id],
    );
    const withDelta = versions.map((v, i) => {
      const prev = versions[i + 1]?.element_counts ?? {};
      const keys = [...new Set([...Object.keys(v.element_counts), ...Object.keys(prev)])].sort();
      return { ...v, changes: keys.map((k) => ({ type: k, count: v.element_counts[k] ?? 0, change: (v.element_counts[k] ?? 0) - (prev[k] ?? 0) })) };
    });
    return { ...row, versions: withDelta, myRole: access.role };
  });
};
