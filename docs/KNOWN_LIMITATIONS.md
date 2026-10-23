# Known limitations (0.2.0, 2026-10-22)

- **Not Procore parity.** See FEATURE_PARITY.md for what is and is not built (no meetings, timesheets, bidding, BIM, scheduling).
- **No SSO or MFA.** Password + session only.
- **Login rate limiting is in-memory**, per process — run one app instance per database.
- **Storage is local disk only.** No S3 driver yet; back up the files directory/volume.
- **Uploads are not virus-scanned.**
- **Offline mode creates records only** (daily logs, punch items, observations, incidents, inspections). Editing and photo upload need a connection.
- **Email is optional.** Without SMTP, invitation and reset links are shared manually.
- **PGlite is single-process.** Use PostgreSQL for shared deployments. PostgreSQL passes the full API suite and recovery drill in CI but has not been load-tested.
- **CUA GUI testing cannot change native dropdowns on this Windows host** (focus-stealing protection blocks keyboard input; option clicks do not commit). Those setup steps run via the API in the CUA script; dropdowns are covered by Playwright.
- **Budget report** uses per-cost-code subqueries; fine to hundreds of cost codes (see PERFORMANCE.md).
- **English only.** Automated axe scan is clean for serious/critical WCAG A/AA issues; no manual screen-reader audit yet.
- **Branch protection** is unavailable on the private repo (GitHub plan).
