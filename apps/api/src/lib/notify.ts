import type { Queryable } from "../db/db.js";

export interface Notice {
  kind: string;
  title: string;
  link?: string;
  projectId?: string | null;
  actorId?: string | null;
}

export type Notifier = (q: Queryable, userIds: (string | null | undefined)[], n: Notice) => Promise<void>;

/** Optional outbound channel (email). Errors are logged by the caller's mailer and never fail the request. */
export type Mailer = (to: string, subject: string, text: string) => Promise<void>;

/**
 * In-app notifications, written in the caller's transaction. The actor is never notified about their own action.
 * When a mailer is configured, emails are sent after the row is written (best effort, not transactional).
 */
export function createNotifier(opts: { mailer?: Mailer; baseUrl?: string } = {}): Notifier {
  return async (q, userIds, n) => {
    const targets = [...new Set(userIds.filter((u): u is string => !!u && u !== n.actorId))];
    for (const userId of targets) {
      await q.query(
        `INSERT INTO notifications (user_id, project_id, kind, title, link, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, n.projectId ?? null, n.kind, n.title.slice(0, 300), n.link ?? null, n.actorId ?? null],
      );
      if (opts.mailer) {
        const [u] = await q.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
        if (u) {
          const url = n.link && opts.baseUrl ? `${opts.baseUrl}${n.link}` : "";
          opts.mailer(u.email, `[OpenBuild] ${n.title}`, `${n.title}\n\n${url}`).catch(() => {});
        }
      }
    }
  };
}
