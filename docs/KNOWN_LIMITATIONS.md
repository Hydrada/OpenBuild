# Known limitations (as of 0.1.0, 2026-10-22)

- **No email delivery.** Invitations produce a one-time link that the inviter shares manually.
- **No password reset** or session management UI yet.
- **Login rate limiting is in-memory** and per process; a multi-instance deployment needs a shared store.
- **Docker Compose files are untested.** Docker was not installed on the development machine; the stack has not been run.
- **CI runs the API suite on PGlite only.** It has not yet been run against a PostgreSQL server.
- **Only Milestone 1 features exist.** Drawings, RFIs, submittals, field and financial tools are not implemented (see FEATURE_PARITY.md).
- **Single-language UI (English)**, no accessibility audit yet (semantic HTML and labels are used throughout).
- PGlite is single-process; use PostgreSQL for any shared deployment.
