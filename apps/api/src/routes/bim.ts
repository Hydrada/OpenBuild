import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isIfc, summarizeIfc } from "../lib/ifc.js";
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
