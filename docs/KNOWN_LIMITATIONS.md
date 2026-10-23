# Known limitations (0.2.0, 2026-10-22)

- **Not Procore parity.** See FEATURE_PARITY.md for what is and is not built (no bidding or BIM; scheduling supports one finish-to-start predecessor per activity and no P6/MS Project import).
- **No SSO (SAML/OIDC).** Password + optional TOTP two-factor with 10 single-use recovery codes; owners/admins can reset a member's second factor.
- **Login rate limiting is in-memory**, per process — run one app instance per database.
- **S3 storage** is supported (AWS S3, MinIO, R2, Backblaze) and tested against an S3-compatible test server, not yet against a live AWS account. With S3, the backup CLI copies the database only; use bucket versioning/replication for files.
- **Uploads are not virus-scanned.**
- **Offline mode** creates field records and queues edits to daily logs, inspection results and punch-item status. Photo upload, financial and document edits need a connection. Conflicting offline edits are resolved last-writer-wins.
- **Email is optional.** Without SMTP, invitation and reset links are shared manually.
- **PGlite is single-process.** Use PostgreSQL for shared deployments. PostgreSQL passes the full API suite and recovery drill in CI but has not been load-tested.
- **CUA GUI testing cannot change native dropdowns on this Windows host** (focus-stealing protection blocks keyboard input; option clicks do not commit). Those setup steps run via the API in the CUA script; dropdowns are covered by Playwright.
- **Budget report** uses per-cost-code subqueries; fine to hundreds of cost codes (see PERFORMANCE.md).
- **English only.** Automated axe scan is clean for serious/critical WCAG A/AA issues; no manual screen-reader audit yet.
- **Branch protection** is unavailable on the private repo (GitHub plan).
