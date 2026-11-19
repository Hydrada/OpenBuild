# Performance

`node scripts/load-test.mjs <url> [seconds]` seeds one project (300 RFIs, 300 punch items, 200 tasks, 60 daily logs,
40 cost codes) and runs each scenario with 20 concurrent connections.

## Result — 2026-10-22, embedded PGlite, single Node.js process, Windows 11 desktop

| Scenario | Requests/s | p50 | p99 | Errors |
|---|---:|---:|---:|---:|
| Dashboard | 194 | 103 ms | 133 ms | 0 |
| RFI list (300 rows) | 178 | 111 ms | 137 ms | 0 |
| Punch list (300 rows) | 198 | 100 ms | 119 ms | 0 |
| Daily logs (60) | 275 | 72 ms | 88 ms | 0 |
| Budget report (40 cost codes) | 109 | 176 ms | 400 ms | 0 |
| Create task (write + audit) | 470 | 41 ms | 55 ms | 0 |

Seeding 920 records took 3.0 s.

PGlite runs PostgreSQL single-threaded inside the app process, so these numbers are a floor. A typical project team
(tens of concurrent users) uses a small fraction of this capacity.

## Result — 2026-11-19, PostgreSQL 16, GitHub-hosted Ubuntu runner (CI run 44464880501)

Runs on every push in the "PostgreSQL 16" CI job (artifact `postgres-load-test`). Same scenarios, 20 connections each.

**One app instance**

| Scenario | Requests/s | p50 | p99 | Errors |
|---|---:|---:|---:|---:|
| Dashboard | 625 | 31 ms | 43 ms | 0 |
| RFI list (300 rows) | 483 | 40 ms | 59 ms | 0 |
| Punch list (300 rows) | 709 | 27 ms | 42 ms | 0 |
| Daily logs (60) | 1,138 | 17 ms | 27 ms | 0 |
| Budget report (40 cost codes) | 409 | 48 ms | 65 ms | 0 |
| Create task (write + audit) | 1,346 | 14 ms | 20 ms | 0 |

**Two app instances on one database, loaded at the same time** (combined requests/s; worst p99 of the two)

| Scenario | Requests/s | p99 | Errors |
|---|---:|---:|---:|
| Dashboard | 536 | 162 ms | 0 |
| RFI list (300 rows) | 628 | 94 ms | 0 |
| Punch list (300 rows) | 823 | 78 ms | 0 |
| Daily logs (60) | 745 | 85 ms | 0 |
| Budget report (40 cost codes) | 449 | 136 ms | 0 |
| Create task (write + audit) | 1,637 | 35 ms | 0 |

PostgreSQL is 2-4x faster than PGlite for every scenario. In the two-instance run, both app servers, both load
generators and PostgreSQL share one small runner, so it shows that instances work side by side under load (shared
sign-in limits, SAML replay records and migrations) rather than how far throughput scales on separate machines.
Starting both instances together on an empty database is also covered: migrations take an advisory lock.

Known hot spot: the budget report computes each column with correlated subqueries per cost code. It is fine at hundreds of
cost codes; rewrite with grouped CTEs if a project needs thousands.
