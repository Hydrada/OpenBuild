import type { Queryable } from "../db/db.js";

export interface AuditEntry {
  orgId: string | null;
  projectId?: string | null;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
}

/** Write inside the same transaction as the change it describes, so the two cannot diverge. */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (org_id, project_id, actor_id, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.orgId, e.projectId ?? null, e.actorId, e.action, e.entityType, e.entityId ?? null, JSON.stringify(e.detail ?? {})],
  );
}
