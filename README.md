# OpenBuild

Open-source, self-hostable construction project management: drawings, RFIs, submittals, daily logs, inspections, punch lists,
budgets, change orders and pay applications, with subcontractor access. An independent alternative to Procore — not a clone and
not at feature parity (see the [sourced feature matrix](docs/FEATURE_PARITY.md)).

**Status: 0.2.0 (unreleased).** All six roadmap milestones pass their acceptance tests; read the [known limitations](docs/KNOWN_LIMITATIONS.md).

## What it does
- **Project management:** companies, projects, roles (owner/admin/member; manager/contributor/viewer/subcontractor), invitations, tasks, schedule and milestones, meetings, dashboard, activity.
- **Documents:** drawing sheets and revisions with an inline viewer and markup sets, document versions with approval routing, specifications, RFIs, submittals, BIM models with 3D viewer and clash detection.
- **Field:** daily logs with manpower, template inspections, punch list with photo-verified close-out, safety observations, incident reports, photo library, timesheets, offline capture.
- **Financials:** cost codes, budget with transfers and estimate-at-completion, contracts, change events and orders, AIA-style pay applications with retainage, bidding with a bidder portal.
- **Collaboration:** comments and @mentions, notifications (in-app and email), approvals inbox, subcontractor portal.
- **Administration:** audit log, custom fields, CSV import/export, API keys, backup/restore, single sign-on (OIDC, SAML), two-factor login, password resets and session control.

## Run it
Requires Node.js 22+.

```sh
npm install
npm run build
npm start            # http://127.0.0.1:3000 — embedded PostgreSQL in ./data, no database server needed
```

Shared server: `docker compose up -d --build` (PostgreSQL 16). See [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Tests
```sh
npm test               # 90 API tests incl. golden financial math and an authorization sweep over every route
npm run test:e2e       # 27 Playwright browser tests incl. offline sync and an axe accessibility scan
node scripts/smoke.mjs # install → hard kill → restart → backup → restore drill
node scripts/load-test.mjs http://127.0.0.1:3000
node e2e/cua/gui-full.mjs http://127.0.0.1:3200 run docs/evidence/gui-full  # real GUI via CUA Driver (then: after-restart)
```
Evidence from the latest GUI runs: [docs/evidence](docs/evidence).

## Docs
[Architecture & decisions](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Deployment & backups](docs/DEPLOYMENT.md) · [Security](docs/SECURITY.md) ·
[Performance](docs/PERFORMANCE.md) · [Integrations](docs/INTEGRATIONS.md) · [Roadmap](docs/ROADMAP.md) · [Feature matrix](docs/FEATURE_PARITY.md) ·
[Known limitations](docs/KNOWN_LIMITATIONS.md) · [Changelog](docs/CHANGELOG.md)

## License
MIT
