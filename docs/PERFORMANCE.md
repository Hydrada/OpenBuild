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
(tens of concurrent users) uses a small fraction of this capacity. PostgreSQL has not been load-tested yet.

Known hot spot: the budget report computes each column with correlated subqueries per cost code. It is fine at hundreds of
cost codes; rewrite with grouped CTEs if a project needs thousands.
