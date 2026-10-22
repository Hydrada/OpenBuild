# OpenBuild

Open-source, self-hostable construction project management: projects, teams and permissions today, with drawings, RFIs, submittals,
field tools and financials on the [roadmap](docs/ROADMAP.md). An independent alternative to Procore; it does not claim feature parity
(see the [sourced feature matrix](docs/FEATURE_PARITY.md)).

**Status: 0.1.0, Milestone 1 (foundation) — early, not production-ready.** Read [known limitations](docs/KNOWN_LIMITATIONS.md).

## What works now
- Create an organization, sign in/out (scrypt passwords, revocable server sessions, CSRF guard, login rate limit)
- Projects with stage, number, address and dates
- Company roles (owner / admin / member) and project roles (manager / contributor / viewer), enforced server-side
- One-time invitation links that add people to the company and optionally a project
- Tasks with assignees and due dates; dashboard with overdue counts and "my tasks"
- Append-only audit log and per-project activity feed

## Run it (no database server needed)
Requires Node.js 22+.

```sh
npm install
npm run build
npm start            # http://127.0.0.1:3000 — data in ./data/pglite (embedded Postgres)
```

Development with hot reload: `npm run dev` (API on :3000, web on :5173).

To use PostgreSQL instead, set `DATABASE_URL` (see `.env.example`). Migrations run automatically at startup, or via `npm run migrate`.

## Tests
```sh
npm test             # API: auth, roles, org isolation, invitations, audit, restart persistence
npm run test:e2e     # Playwright browser flow against the built server
node e2e/cua/gui-flow.mjs http://127.0.0.1:3200 setup docs/evidence/m1-gui          # real GUI via CUA Driver
node e2e/cua/gui-flow.mjs http://127.0.0.1:3200 after-restart docs/evidence/m1-gui  # after restarting the server
```
Latest GUI evidence (screenshots + results JSON): [docs/evidence/m1-gui](docs/evidence/m1-gui).

## Docs
[Architecture & decisions](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md) · [Feature matrix](docs/FEATURE_PARITY.md) ·
[Integrations with OpenDraft / Acrobat alternative](docs/INTEGRATIONS.md) · [Known limitations](docs/KNOWN_LIMITATIONS.md)

## License
MIT
