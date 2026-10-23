import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { D, fmt, nonNegativeMoney } from "../lib/money.js";
import { requireProject } from "../lib/permissions.js";
import { loadInProject, nextNumber } from "../lib/records.js";
import { newToken, sha256 } from "../lib/security.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

/**
 * Bid management: packages are issued to bidder companies, who submit through a private single-package link
 * (no account needed). Bids can be revised until the due time or until the package is closed.
 * Awarding creates a draft subcontract for the winning amount.
 */
export const biddingRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  app.get<P>("/projects/:projectId/bid-packages", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT b.id, b.number, b.title, b.due_at, b.status,
              (SELECT count(*)::int FROM bidders x WHERE x.package_id = b.id) AS invited,
              (SELECT count(*)::int FROM bidders x WHERE x.package_id = b.id AND x.status = 'submitted') AS submitted,
              (SELECT min(amount)::text FROM bidders x WHERE x.package_id = b.id AND x.status = 'submitted') AS low_bid
         FROM bid_packages b WHERE b.project_id = $1 ORDER BY b.number DESC`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/bid-packages", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const b = z.object({
      title: z.string().trim().min(1).max(300),
      scope: z.string().trim().max(20000).nullable().optional(),
      costCodeId: z.uuid().nullable().optional(),
      dueAt: z.iso.datetime({ offset: true }),
    }).parse(req.body);
    if (new Date(b.dueAt).getTime() <= Date.now()) throw new HttpError(400, "The due date must be in the future");
    const pkg = await db.tx(async (q) => {
      if (b.costCodeId && !(await q.query("SELECT 1 FROM cost_codes WHERE id = $1 AND project_id = $2", [b.costCodeId, project.id])).length) throw new HttpError(400, "Unknown cost code");
      const number = await nextNumber(q, "bid_packages", project.id);
      const [row] = await q.query<{ id: string }>(
        `INSERT INTO bid_packages (project_id, number, title, scope, cost_code_id, due_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [project.id, number, b.title, b.scope ?? null, b.costCodeId ?? null, b.dueAt, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "bid_package.create", entityType: "bid_package", entityId: row!.id, detail: { number, title: b.title } });
      return row!;
    });
    return reply.code(201).send(pkg);
  });

  /** Package with bid leveling: submitted bids ranked, with spread from the low bid. */
  app.get<Id>("/bid-packages/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "bid_packages", req.params.id, user.id, "read.full", "Bid package");
    const [pkg] = await db.query(
      `SELECT b.*, c.code AS cost_code, k.number AS contract_number FROM bid_packages b
         LEFT JOIN cost_codes c ON c.id = b.cost_code_id LEFT JOIN contracts k ON k.id = b.contract_id WHERE b.id = $1`,
      [row.id],
    );
    const bidders = await db.query<{ id: string; status: string; amount: string | null }>(
      `SELECT id, company, email, status, amount::text, notes, submitted_at FROM bidders WHERE package_id = $1
        ORDER BY (status = 'submitted') DESC, amount NULLS LAST, company`,
      [row.id],
    );
    const low = bidders.filter((x) => x.status === "submitted" && x.amount !== null).map((x) => new D(x.amount!));
    const lowest = low.length ? D.min(...low) : null;
    return {
      ...pkg,
      bidders: bidders.map((x) => ({
        ...x,
        over_low: lowest && x.amount !== null && x.status === "submitted" ? fmt(new D(x.amount).minus(lowest)) : null,
        over_low_percent: lowest && !lowest.isZero() && x.amount !== null && x.status === "submitted" ? fmt(new D(x.amount).minus(lowest).div(lowest).times(100)) : null,
      })),
      low_bid: lowest ? fmt(lowest) : null,
      myRole: access.role,
    };
  });

  app.post<Id>("/bid-packages/:id/bidders", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string; title: string; due_at: string }>(db, "bid_packages", req.params.id, user.id, "record.manage", "Bid package");
    if (row.status !== "open") throw new HttpError(409, "The package is not open for bidding");
    const b = z.object({ company: z.string().trim().min(1).max(200), email: z.string().trim().toLowerCase().pipe(z.email()) }).parse(req.body);
    const { token, hash } = newToken();
    const bidder = await db.tx(async (q) => {
      const [x] = await q.query<{ id: string }>(`INSERT INTO bidders (package_id, company, email, token_hash) VALUES ($1, $2, $3, $4) RETURNING id`, [row.id, b.company, b.email, hash]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "bid.invite", entityType: "bid_package", entityId: row.id, detail: b });
      return x!;
    });
    const bidPath = `/bid/${token}`;
    let emailSent = false;
    if (config.mailer && config.baseUrl) {
      emailSent = await config.mailer(b.email, `Invitation to bid: ${row.title}`, `${b.company} is invited to bid on "${row.title}".\n\nSubmit by ${new Date(row.due_at).toUTCString()}: ${config.baseUrl}${bidPath}`).then(() => true, () => false);
    }
    return reply.code(201).send({ id: bidder.id, bidPath, emailSent });
  });

  app.post<Id>("/bid-packages/:id/status", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string }>(db, "bid_packages", req.params.id, user.id, "record.manage", "Bid package");
    const b = z.object({ status: z.enum(["open", "closed"]) }).parse(req.body);
    if (row.status === "awarded") throw new HttpError(409, "The package has been awarded");
    return db.tx(async (q) => {
      await q.query("UPDATE bid_packages SET status = $2 WHERE id = $1", [row.id, b.status]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: `bid_package.${b.status}`, entityType: "bid_package", entityId: row.id });
      return { ok: true };
    });
  });

  app.post<Id>("/bid-packages/:id/award", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string; title: string; cost_code_id: string | null; number: number }>(db, "bid_packages", req.params.id, user.id, "record.manage", "Bid package");
    const b = z.object({ bidderId: z.uuid() }).parse(req.body);
    if (row.status === "awarded") throw new HttpError(409, "Already awarded");
    if (!row.cost_code_id) throw new HttpError(400, "Set a cost code on the package before awarding");
    return db.tx(async (q) => {
      const [bidder] = await q.query<{ id: string; company: string; amount: string; status: string }>("SELECT id, company, amount::text, status FROM bidders WHERE id = $1 AND package_id = $2", [b.bidderId, row.id]);
      if (!bidder) throw new HttpError(404, "Bidder not found");
      if (bidder.status !== "submitted") throw new HttpError(400, "That bidder has not submitted a bid");
      const number = await nextNumber(q, "contracts", row.project_id);
      const [k] = await q.query<{ id: string }>(
        `INSERT INTO contracts (project_id, number, kind, title, counterparty, created_by) VALUES ($1, $2, 'subcontract', $3, $4, $5) RETURNING id`,
        [row.project_id, number, row.title, bidder.company, user.id],
      );
      await q.query(`INSERT INTO contract_lines (contract_id, seq, cost_code_id, description, amount) VALUES ($1, 1, $2, $3, $4)`, [k!.id, row.cost_code_id, `Bid package #${row.number}: ${row.title}`, bidder.amount]);
      await q.query("UPDATE bid_packages SET status = 'awarded', awarded_bidder_id = $2, contract_id = $3 WHERE id = $1", [row.id, bidder.id, k!.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "bid_package.award", entityType: "bid_package", entityId: row.id, detail: { company: bidder.company, amount: bidder.amount, contractId: k!.id } });
      return { ok: true, contractId: k!.id };
    });
  });

  // ---------- Bidder portal (token link, no account) ----------

  async function findBidder(token: string) {
    const [x] = await db.query<{ id: string; company: string; status: string; amount: string | null; notes: string | null; title: string; scope: string | null; due_at: string; package_status: string; project_name: string; org_name: string; past_due: boolean }>(
      `SELECT x.id, x.company, x.status, x.amount::text, x.notes, b.title, b.scope, b.due_at, b.status AS package_status,
              p.name AS project_name, o.name AS org_name, b.due_at < now() AS past_due
         FROM bidders x JOIN bid_packages b ON b.id = x.package_id JOIN projects p ON p.id = b.project_id JOIN organizations o ON o.id = p.org_id
        WHERE x.token_hash = $1`,
      [sha256(token)],
    );
    if (!x) throw new HttpError(404, "Bid invitation not found");
    return x;
  }

  app.get<{ Params: { token: string } }>("/bids/:token", async (req) => {
    const x = await findBidder(req.params.token);
    return { company: x.company, status: x.status, amount: x.amount, notes: x.notes, title: x.title, scope: x.scope, dueAt: x.due_at, open: x.package_status === "open" && !x.past_due, project: x.project_name, organization: x.org_name };
  });

  app.post<{ Params: { token: string } }>("/bids/:token", async (req) => {
    const x = await findBidder(req.params.token);
    if (x.package_status !== "open" || x.past_due) throw new HttpError(409, "Bidding on this package is closed");
    const b = z.union([
      z.object({ decline: z.literal(true) }),
      z.object({ amount: nonNegativeMoney, notes: z.string().trim().max(5000).nullable().optional() }),
    ]).parse(req.body);
    await db.query(
      "decline" in b
        ? "UPDATE bidders SET status = 'declined', amount = NULL, submitted_at = now() WHERE id = $1"
        : "UPDATE bidders SET status = 'submitted', amount = $2, notes = $3, submitted_at = now() WHERE id = $1",
      "decline" in b ? [x.id] : [x.id, b.amount, b.notes ?? null],
    );
    return { ok: true };
  });
};
