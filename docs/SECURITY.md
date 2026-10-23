# Security

Report vulnerabilities privately to the repository owner; do not open a public issue.

## Design

| Area | Control | Verified by |
|---|---|---|
| Passwords | scrypt (N=2^15, r=8, p=1, 16-byte salt), ≥10 chars, constant-time compare, dummy hash for unknown users | `foundation.test.ts` |
| Two-factor | Optional TOTP (RFC 6238, SHA-1, 30 s, ±1 step), asked only after a correct password, counted by the login rate limiter, disabling requires password + code; 10 hashed single-use recovery codes; owner/admin reset (with cross-org guard) signs the person out | `meetings.test.ts`, `e2e/meetings.spec.ts` |
| Sessions | 256-bit random tokens, only SHA-256 stored, httpOnly + SameSite=Lax (+Secure when configured), 14-day expiry, list/revoke, password change signs out other devices, reset signs out all | `security.test.ts`, `documents.test.ts` |
| CSRF | Cookie-authenticated writes require the `X-OpenBuild-CSRF` header (a cross-site form cannot set it) | `foundation.test.ts` |
| Brute force | 10 failed logins / 15 min per IP+email | `foundation.test.ts` |
| Authorization | Every route checks org role, then project role; subcontractors only see records assigned to them; other companies' ids return 404 | **route-inventory sweep** in `security.test.ts`: every one of 135 routes is called anonymously (must be 401) and as a signed-in outsider with real ids (must be 4xx) |
| API keys | `ob_` + 256-bit secret, hashed, bound to one company via request scope, require the creator to still be an admin, revocable, optional expiry | `collab.test.ts` |
| Tokens (invite, reset, tool links) | Single-use where applicable, expiring, hashed at rest, unknown = expired = 404 | `documents.test.ts`, `collab.test.ts`, `security.test.ts` |
| SQL injection | Parameterised queries only; dynamic `UPDATE` column names come from fixed allow-lists | `security.test.ts` |
| Mass assignment | Request bodies are parsed with Zod schemas; unknown keys are dropped | `security.test.ts` |
| XSS | React escaping; CSP `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; uploads served inline only for PDF/images, everything else as `application/octet-stream` attachments; `nosniff` | `security.test.ts` |
| CSV/formula injection | Exported cells starting with `= + - @` are prefixed with `'` | `collab.test.ts` |
| Uploads | Size limit (100 MB default), one file per request, server-generated storage keys, path-traversal guard, PDF magic-byte check for drawings | `security.test.ts`, `documents.test.ts` |
| Audit | Every change writes an audit row in the same transaction; the table is append-only **enforced by database triggers** | `security.test.ts` |
| Money | NUMERIC(18,2) + decimal.js half-even; never floats | `financials.test.ts` |
| Dependencies | `npm audit --omit=dev --audit-level=high` in CI | CI |

## Known gaps

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md): no SSO yet, in-memory rate limiting, no antivirus scanning of uploads, no per-field encryption at rest (use disk/volume encryption).
