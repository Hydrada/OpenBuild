# Roadmap and acceptance criteria

A milestone is complete only when its acceptance tests pass, its GUI workflows are verified (Playwright + CUA Driver), no critical
security issue is open, migrations run on a fresh and an existing database, docs and known limitations are updated, and the work is pushed.

## M1 — Foundation (in progress)
- [x] Auth: register org, sign in/out, scrypt, sessions, CSRF header, login rate limit
- [x] Organizations, projects, org + project roles, invitations (link-based)
- [x] Dashboard, tasks, activity feed, audit log
- [x] Migrations (append-only), PGlite + Postgres drivers
- [x] API tests (17), Playwright e2e, CUA GUI run incl. restart persistence
- [x] CI workflow
- [ ] Verify the Docker Compose stack on a machine with Docker (not available on the dev box)
- [ ] Run the API test suite against real PostgreSQL 16 in CI (service container)
- [ ] Password reset, session list/revoke, member deactivation
Acceptance: `npm test`, `npm run test:e2e`, `e2e/cua/gui-flow.mjs` (setup + after-restart) all pass.

## M2 — Construction documentation
Drawings (sets, sheets, revisions, current-set logic), documents with versions, specifications, RFIs (ball-in-court, due dates, official response), submittals (packages, workflow steps, revisions), approval workflows. File storage via S3-compatible API with a local-disk driver.
Acceptance: upload a drawing set, supersede with a revision, raise an RFI referencing a sheet, route a submittal through 2 reviewers — via GUI.

## M3 — Field operations
Daily logs (weather, manpower, notes, photos), inspections from templates, punch lists with assignee/verify flow, observations/incidents, photo library.
Acceptance: complete an inspection with a failed item that creates a punch item; close it with a photo.

## M4 — Financials
Cost codes, budgets, prime contract, commitments, change events → change orders, invoices/pay apps with retainage, forecasting. Decimal-safe (ADR-006), every financial mutation audited.
Acceptance: golden-file tests for budget roll-ups and pay-app math; GUI flow from change event to approved CO updating the revised budget.

## M5 — Collaboration and integrations
Notifications (in-app + SMTP), comments/mentions, approval routing, subcontractor company scoping, API keys + REST docs, OpenDraft / Acrobat adapters (INTEGRATIONS.md).

## M6 — Production readiness
Security review (OWASP ASVS L2 checklist), load test, offline capture/sync for field tools, backup/restore drill, WCAG 2.2 AA audit, installer validation, release packaging.
