# Architecture

OpenBuild is a single deployable Node.js service with a React client and a PostgreSQL database.

```
browser ──HTTPS──> Fastify API (apps/api) ──SQL──> PostgreSQL 16+   (production)
   ▲                    │                    └──> PGlite (embedded) (dev, tests, single-machine eval)
   └── static SPA ──────┘  apps/web/dist served by the API
```

| Layer | Choice | Where |
|---|---|---|
| Client | React 19 + TypeScript, Vite build, tiny history router | `apps/web` |
| API | Fastify 5 + TypeScript, Zod validation | `apps/api/src` |
| Database | PostgreSQL via `pg`; PGlite (Postgres compiled to WASM) when `DATABASE_URL` is unset | `apps/api/src/db` |
| Migrations | Ordered, append-only SQL in `db/migrations/index.ts`, recorded in `schema_migrations`, each in a transaction | |
| Auth | scrypt password hashes, random session tokens (only SHA-256 stored), httpOnly SameSite=Lax cookie | `lib/security.ts`, `routes/auth.ts` |
| Authorization | Org roles + project roles, checked server-side on every route | `lib/permissions.ts` |
| Audit | Append-only `audit_log` written in the same transaction as each change | `lib/audit.ts` |
| Tests | Vitest (API, in-memory PGlite), Playwright (browser), CUA Driver (real GUI) | `apps/api/test`, `e2e/` |

## Architecture decision records

### ADR-001 — TypeScript end to end, Fastify rather than NestJS (2026-10-22)
One language across client and server keeps the data contracts readable and lets contributors move between layers. Fastify was chosen over NestJS: it gives schema-friendly routing and plugins without NestJS's decorator/DI framework weight, and the module boundaries we need (one route plugin per domain area) don't require a DI container. FastAPI was the main alternative; it was rejected only to avoid a second language in the repo.

### ADR-002 — PostgreSQL, with PGlite as the zero-install engine (2026-10-22)
PostgreSQL is the production database (NUMERIC for money, JSONB for custom fields, row-level locking, mature backup tooling). PGlite runs the *same* Postgres SQL in-process, so the test suite, local development and a one-machine evaluation need no database server and no Docker. Both drivers sit behind a 2-method `Db` interface (`query`, `tx`). Consequence: SQL must stay within what PGlite supports (it is real Postgres 17, so in practice everything except extensions we have not loaded). Production deployments should use real Postgres; PGlite is single-process.

### ADR-003 — Hand-written SQL, no ORM (2026-10-22)
Queries are short and permission-heavy (joins against memberships). Plain parameterized SQL keeps those checks visible in review. Dynamic `UPDATE`s only interpolate column names from a fixed whitelist (`toSet` in `routes/projects.ts`); values are always bound parameters. Revisit if query count makes a typed builder (Kysely) worthwhile.

### ADR-004 — Permission model (2026-10-22)
- Org roles: `owner` (one per org, can grant admin), `admin` (full access to all projects, can invite members), `member` (sees only projects they are a member of).
- Project roles: `manager` (edit project, manage project team, everything a contributor can do), `contributor` (create/edit records), `viewer` (read only).
- Org owners/admins are an implicit `admin` on every project.
- Unauthorized access to another org's resource returns 404, not 403, so ids cannot be probed.
Future modules add actions to the `ALLOWED` matrix rather than ad-hoc checks. Subcontractor-company scoping (Module E) will layer on this by adding a company id to memberships.

### ADR-005 — Sessions and CSRF (2026-10-22)
Server-side sessions in Postgres (revocable, 14-day expiry). The cookie is httpOnly + SameSite=Lax; additionally every non-GET `/api` request must carry `X-OpenBuild-CSRF`, which a cross-site form cannot set. API keys for integrations (Milestone 5) will be a separate bearer-token path.

### ADR-006 — Money (decided now, implemented in Milestone 4)
All amounts are `NUMERIC(18,2)` in Postgres and are returned to JavaScript as **strings** (type parsers registered for both drivers in `db/db.ts`). Arithmetic in the API uses `decimal.js`; never `Number`. Rounding: half-even at the line level, documented per calculation.

### ADR-007 — Integration with OpenDraft (Bluebeam alternative) and the Acrobat alternative
OpenBuild does not reimplement PDF markup. It stores drawings and documents and hands them to an external viewer/editor through a small adapter interface; see [INTEGRATIONS.md](INTEGRATIONS.md). Neither sibling repository is modified by this project.

### ADR-008 — License: MIT (2026-10-22)
All runtime dependencies are MIT/ISC/BSD/Apache-2.0/BlueOak (MPL-2.0 appears only in build tooling: lightningcss). MIT matches the published OpenDraft project. **Owner decision before public release:** AGPL-3.0 would require hosted forks to publish their changes; switching is easy while the owner is the only contributor.
