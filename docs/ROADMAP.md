# Roadmap and acceptance status

A milestone is complete when its acceptance tests pass, GUI workflows are verified, no critical security issue is open,
migrations work on fresh and existing databases, docs and limitations are updated, and work is committed.

| Milestone | Status | Evidence |
|---|---|---|
| M1 Foundation | Complete | `foundation.test.ts`, `documents.test.ts` (accounts), `e2e/foundation.spec.ts`, CUA `docs/evidence/m1-gui` |
| M2 Construction documentation | Complete | `documents.test.ts`, `e2e/documents.spec.ts`, CUA `docs/evidence/gui-full` |
| M3 Field operations | Complete | `field.test.ts`, `e2e/field.spec.ts` (incl. offline), CUA |
| M4 Financials | Complete | `financials.test.ts` (golden numbers), `e2e/financials.spec.ts`, CUA pay application |
| M5 Collaboration & integrations | Complete | `collab.test.ts`, `e2e/collab.spec.ts` |
| M6 Production readiness | Complete with recorded limitations | `security.test.ts` (route sweep), axe scan, `scripts/load-test.mjs`, `scripts/smoke.mjs`, CI on PGlite + PostgreSQL 16 + Docker Compose |

Test totals (2026-10-22): 60 API tests, 15 Playwright tests, 23 CUA Driver GUI checks, install/recovery drill, load test.

## Next (not started)
Meetings, timesheets, bidding; SSO/MFA; offline editing and offline photo upload; S3 storage driver; PostgreSQL load test;
multi-instance rate limiting; schedule (Gantt) module.
