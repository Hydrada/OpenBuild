import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { D, fmt, nonNegativeMoney } from "../lib/money.js";
import { isUuid, requireOrgRole, requireProject } from "../lib/permissions.js";
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
      `SELECT x.id, x.company, x.email, x.status, x.amount::text, x.notes, x.submitted_at, c.prequal_status
         FROM bidders x LEFT JOIN bidder_companies c ON c.id = x.company_id WHERE x.package_id = $1
        ORDER BY (x.status = 'submitted') DESC, x.amount NULLS LAST, x.company`,
      [row.id],
    );
    const low = bidders.filter((x) => x.status === "submitted" && x.amount !== null).map((x) => new D(x.amount!));
    const lowest = low.length ? D.min(...low) : null;
    const files = await db.query(
      `SELECT f.id, f.name, f.size FROM bid_package_files bf JOIN files f ON f.id = bf.file_id WHERE bf.package_id = $1 ORDER BY f.name`,
      [row.id],
    );
    return {
      ...pkg,
      org_id: access.project.org_id,
      files,
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
    const b = z.union([
      z.object({ companyId: z.uuid() }),
      z.object({ company: z.string().trim().min(1).max(200), email: z.string().trim().toLowerCase().pipe(z.email()) }),
    ]).parse(req.body);
    let company: string, email: string, companyId: string | null = null;
    if ("companyId" in b) {
      // From the bidder directory: only prequalified companies may be invited.
      const [c] = await db.query<{ name: string; email: string; prequal_status: string }>(
        "SELECT c.name, c.email, c.prequal_status FROM bidder_companies c WHERE c.id = $1 AND c.org_id = $2", [b.companyId, access.project.org_id],
      );
      if (!c) throw new HttpError(404, "Company not found");
      if (c.prequal_status !== "approved") throw new HttpError(400, `${c.name} is not prequalified (${c.prequal_status})`);
      ({ name: company, email } = c);
      companyId = b.companyId;
    } else {
      ({ company, email } = b);
    }
    const { token, hash } = newToken();
    const bidder = await db.tx(async (q) => {
      const [x] = await q.query<{ id: string }>(`INSERT INTO bidders (package_id, company, email, token_hash, company_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [row.id, company, email, hash, companyId]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "bid.invite", entityType: "bid_package", entityId: row.id, detail: { company, email, companyId } });
      return x!;
    });
    const bidPath = `/bid/${token}`;
    let emailSent = false;
    if (config.mailer && config.baseUrl) {
      emailSent = await config.mailer(email, `Invitation to bid: ${row.title}`, `${company} is invited to bid on "${row.title}".\n\nSubmit by ${new Date(row.due_at).toUTCString()}: ${config.baseUrl}${bidPath}`).then(() => true, () => false);
    }
    return reply.code(201).send({ id: bidder.id, bidPath, emailSent });
  });

  /** Planroom: share a project file (drawing sheet, spec, document version) with this package's bidders. */
  app.post<Id>("/bid-packages/:id/files", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "bid_packages", req.params.id, user.id, "record.manage", "Bid package");
    const b = z.object({ fileId: z.uuid() }).parse(req.body);
    const [f] = await db.query<{ name: string }>("SELECT name FROM files WHERE id = $1 AND project_id = $2", [b.fileId, row.project_id]);
    if (!f) throw new HttpError(400, "File not found in this project");
    await db.tx(async (q) => {
      await q.query("INSERT INTO bid_package_files (package_id, file_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [row.id, b.fileId]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "bid_package.share_file", entityType: "bid_package", entityId: row.id, detail: { file: f.name } });
    });
    return reply.code(201).send({ ok: true });
  });

  app.delete<{ Params: { id: string; fileId: string } }>("/bid-packages/:id/files/:fileId", async (req) => {
    const user = requireUser(req);
    const { row } = await loadInProject<{ id: string; project_id: string }>(db, "bid_packages", req.params.id, user.id, "record.manage", "Bid package");
    await db.query("DELETE FROM bid_package_files WHERE package_id = $1 AND file_id::text = $2", [row.id, req.params.fileId]);
    return { ok: true };
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

  // ---------- Bidder directory and prequalification (company level) ----------

  type O = { Params: { orgId: string } };
  const companyInput = z.object({
    name: z.string().trim().min(1).max(200),
    trade: z.string().trim().max(100).nullable().optional(),
    email: z.string().trim().toLowerCase().pipe(z.email()),
    bondingLimit: nonNegativeMoney.nullable().optional(),
    insuranceExpires: z.iso.date().nullable().optional(),
    emr: z.union([z.number(), z.string()]).transform(String).pipe(z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, "EMR like 0.85")).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
  });

  app.get<O & { Querystring: { trade?: string } }>("/orgs/:orgId/bidder-companies", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId)) throw new HttpError(404, "Organization not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    return db.query(
      `SELECT c.id, c.name, c.trade, c.email, c.prequal_status, c.bonding_limit::text, c.insurance_expires, c.emr::text, c.notes, c.reviewed_at,
              (c.insurance_expires IS NOT NULL AND c.insurance_expires < current_date) AS insurance_expired, r.name AS reviewed_by_name
         FROM bidder_companies c LEFT JOIN users r ON r.id = c.reviewed_by
        WHERE c.org_id = $1 AND ($2::text IS NULL OR c.trade ILIKE $2) ORDER BY c.name`,
      [req.params.orgId, req.query.trade ? `%${req.query.trade}%` : null],
    );
  });

  app.post<O>("/orgs/:orgId/bidder-companies", async (req, reply) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId)) throw new HttpError(404, "Organization not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const b = companyInput.parse(req.body);
    if ((await db.query("SELECT 1 FROM bidder_companies WHERE org_id = $1 AND lower(name) = lower($2)", [req.params.orgId, b.name])).length) throw new HttpError(409, "That company is already in the directory");
    const [c] = await db.query(
      `INSERT INTO bidder_companies (org_id, name, trade, email, bonding_limit, insurance_expires, emr, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.params.orgId, b.name, b.trade ?? null, b.email, b.bondingLimit ?? null, b.insuranceExpires ?? null, b.emr ?? null, b.notes ?? null],
    );
    await audit(db, { orgId: req.params.orgId, actorId: user.id, action: "bidder_company.create", entityType: "bidder_company", entityId: (c as { id: string }).id, detail: { name: b.name } });
    return reply.code(201).send(c);
  });

  /** Prequalification decision; approving requires current insurance on file. */
  app.post<O & { Params: { orgId: string; id: string } }>("/orgs/:orgId/bidder-companies/:id/prequal", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId) || !isUuid(req.params.id)) throw new HttpError(404, "Company not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const b = z.object({ status: z.enum(["approved", "rejected", "pending"]), notes: z.string().trim().max(5000).optional() }).parse(req.body);
    return db.tx(async (q) => {
      const [c] = await q.query<{ insurance_expires: string | null }>("SELECT insurance_expires FROM bidder_companies WHERE id = $1 AND org_id = $2", [req.params.id, req.params.orgId]);
      if (!c) throw new HttpError(404, "Company not found");
      if (b.status === "approved" && (!c.insurance_expires || c.insurance_expires < new Date().toISOString().slice(0, 10))) throw new HttpError(400, "Record a current insurance expiry date before approving");
      await q.query("UPDATE bidder_companies SET prequal_status = $3, notes = coalesce($4, notes), reviewed_by = $5, reviewed_at = now() WHERE id = $1 AND org_id = $2", [req.params.id, req.params.orgId, b.status, b.notes ?? null, user.id]);
      await audit(q, { orgId: req.params.orgId, actorId: user.id, action: `bidder_company.${b.status}`, entityType: "bidder_company", entityId: req.params.id, detail: b });
      return { ok: true };
    });
  });

  // ---------- Bidder portal (token link, no account) ----------

  async function findBidder(token: string) {
    const [x] = await db.query<{ id: string; package_id: string; company: string; status: string; amount: string | null; notes: string | null; title: string; scope: string | null; due_at: string; package_status: string; project_name: string; org_name: string; past_due: boolean }>(
      `SELECT x.id, x.package_id, x.company, x.status, x.amount::text, x.notes, b.title, b.scope, b.due_at, b.status AS package_status,
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
    const files = await db.query("SELECT f.id, f.name, f.size FROM bid_package_files bf JOIN files f ON f.id = bf.file_id WHERE bf.package_id = $1 ORDER BY f.name", [x.package_id]);
    return { files, company: x.company, status: x.status, amount: x.amount, notes: x.notes, title: x.title, scope: x.scope, dueAt: x.due_at, open: x.package_status === "open" && !x.past_due, project: x.project_name, organization: x.org_name };
  });

  /** Planroom download for a bidder: only files shared with their package. */
  app.get<{ Params: { token: string; fileId: string } }>("/bids/:token/files/:fileId", async (req, reply) => {
    const x = await findBidder(req.params.token);
    const [f] = await db.query<{ storage_key: string; name: string; size: string }>(
      "SELECT f.storage_key, f.name, f.size FROM bid_package_files bf JOIN files f ON f.id = bf.file_id WHERE bf.package_id = $1 AND f.id::text = $2",
      [x.package_id, req.params.fileId],
    );
    if (!f) throw new HttpError(404, "File not found");
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Length", f.size);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(await config.storage.get(f.storage_key));
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
