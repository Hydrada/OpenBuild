import type { Queryable } from "../db/db.js";
import { HttpError } from "./errors.js";

export type EntityType = "document" | "submittal";
export type Decision = "approved" | "approved_as_noted" | "revise_resubmit" | "rejected";

/**
 * Sequential approval routing. Each submission opens a new `round`; steps are decided in `seq` order and
 * only the current step's approver may decide it. A negative decision ends the round (later steps skipped).
 */
export async function startRound(q: Queryable, type: EntityType, entityId: string, approverIds: string[]): Promise<number> {
  if (!approverIds.length) throw new HttpError(400, "Choose at least one approver");
  if (new Set(approverIds).size !== approverIds.length) throw new HttpError(400, "An approver is listed twice");
  // Close any unfinished earlier round.
  await q.query(`UPDATE approval_steps SET status = 'skipped' WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending'`, [type, entityId]);
  const [r] = await q.query<{ round: number }>(
    `SELECT coalesce(max(round), 0)::int + 1 AS round FROM approval_steps WHERE entity_type = $1 AND entity_id = $2`,
    [type, entityId],
  );
  for (const [i, approver] of approverIds.entries()) {
    await q.query(
      `INSERT INTO approval_steps (entity_type, entity_id, round, seq, approver_id) VALUES ($1, $2, $3, $4, $5)`,
      [type, entityId, r!.round, i + 1, approver],
    );
  }
  return r!.round;
}

export interface StepRow {
  id: string; entity_type: EntityType; entity_id: string; round: number; seq: number; approver_id: string; status: string;
}

/** Records a decision. Returns the resulting overall outcome, or null while further steps are pending. */
export async function decide(q: Queryable, step: StepRow, userId: string, decision: Decision, comment: string | null): Promise<Decision | null> {
  if (step.status !== "pending") throw new HttpError(409, "This step has already been decided");
  if (step.approver_id !== userId) throw new HttpError(403, "Only the assigned approver can decide this step");
  const [earlier] = await q.query(
    `SELECT 1 FROM approval_steps WHERE entity_type = $1 AND entity_id = $2 AND round = $3 AND seq < $4 AND status = 'pending'`,
    [step.entity_type, step.entity_id, step.round, step.seq],
  );
  if (earlier) throw new HttpError(409, "An earlier approver has not decided yet");
  await q.query(`UPDATE approval_steps SET status = $2, comment = $3, decided_at = now() WHERE id = $1`, [step.id, decision, comment]);

  if (decision === "rejected" || decision === "revise_resubmit") {
    await q.query(
      `UPDATE approval_steps SET status = 'skipped' WHERE entity_type = $1 AND entity_id = $2 AND round = $3 AND status = 'pending'`,
      [step.entity_type, step.entity_id, step.round],
    );
    return decision;
  }
  const [remaining] = await q.query(
    `SELECT 1 FROM approval_steps WHERE entity_type = $1 AND entity_id = $2 AND round = $3 AND status = 'pending'`,
    [step.entity_type, step.entity_id, step.round],
  );
  if (remaining) return null;
  const [noted] = await q.query(
    `SELECT 1 FROM approval_steps WHERE entity_type = $1 AND entity_id = $2 AND round = $3 AND status = 'approved_as_noted'`,
    [step.entity_type, step.entity_id, step.round],
  );
  return noted ? "approved_as_noted" : "approved";
}

export async function listSteps(q: Queryable, type: EntityType, entityId: string) {
  return q.query(
    `SELECT s.id, s.round, s.seq, s.status, s.comment, s.decided_at, s.approver_id, u.name AS approver_name
       FROM approval_steps s JOIN users u ON u.id = s.approver_id
      WHERE s.entity_type = $1 AND s.entity_id = $2 ORDER BY s.round DESC, s.seq`,
    [type, entityId],
  );
}
