# Known limitations (0.2.0, 2026-10-22)

- **Not feature-complete.** See FEATURE_PARITY.md for what is and is not built (BIM clash containment checks assume closed, roughly convex elements; clearance distances are measured between surfaces near the overlap region).
- **SSO** supports OpenID Connect and SAML 2.0, each tested against a simulated identity provider, not yet a live tenant. Users must be invited first. Password + optional TOTP two-factor with recovery codes remains available.
- **S3 storage** is supported (AWS S3, MinIO, R2, Backblaze) and tested against an S3-compatible test server, not yet against a live AWS account. With S3, the backup CLI copies the database only; use bucket versioning/replication for files.
- **Virus scanning is optional** (ClamAV via `OPENBUILD_CLAMD`); without it, uploads are not scanned.
- **Offline mode** creates field records and queues edits to daily logs, inspection results and punch-item status. Financial and document edits need a connection; photos queue on the device. Conflicting offline edits are resolved last-writer-wins.
- **Email is optional.** Without SMTP, invitation and reset links are shared manually.
- **PGlite is single-process.** Use PostgreSQL for shared or multi-instance deployments (rate limiting and SAML replay protection are stored in the database). PostgreSQL passes the full API suite, the recovery drill and a load test (one and two instances) in CI; see PERFORMANCE.md.
- **CUA GUI testing cannot change native dropdowns on this Windows host** (6 of 35 CUA steps use the API for that reason) (focus-stealing protection blocks keyboard input; option clicks do not commit). Those setup steps run via the API in the CUA script; dropdowns are covered by Playwright.
- **Budget report** uses per-cost-code subqueries; fine to hundreds of cost codes (see PERFORMANCE.md).
- **English only.** Every screen passes an automated axe scan for WCAG 2.2 AA plus best practice at every impact level, and keyboard-only use is tested (skip link, visible focus, focus moved into and back out of forms and confirmations). A manual pass with a screen reader (NVDA/Narrator) has not been done yet.
- **Branch protection** is unavailable on the private repo (GitHub plan).
