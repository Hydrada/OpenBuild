# Deploying OpenBuild

Three supported ways to run it. All of them are exercised by CI on every push (see `.github/workflows/ci.yml`).

## 1. Docker Compose (recommended for a shared server)

```sh
git clone <your fork> openbuild && cd openbuild
cp .env.example .env            # set POSTGRES_PASSWORD at minimum
docker compose up -d --build    # PostgreSQL 16 + OpenBuild on http://localhost:3000
```

Volumes: `pgdata` (database) and `files` (uploaded drawings, documents, photos — mounted at `/data`).
CI job **docker** builds the image, starts the stack, creates data, restarts the app container and checks the data is still there.

## 2. Node.js directly (single machine, no database server)

Requires Node.js 22+.

```sh
npm ci && npm run build
npm start                       # embedded PostgreSQL (PGlite) in ./data/pglite, files in ./data/files
```

PGlite is real PostgreSQL compiled to WebAssembly running inside the server process. It is ideal for evaluation and a single site office; use PostgreSQL for anything shared or larger (see Known limitations).

## 3. Release tarball

Pushing a `v*` tag runs `.github/workflows/release.yml`, which tests, builds, runs the install drill and attaches `openbuild-<version>.tar.gz` (+ SHA-256) to a GitHub release:

```sh
tar xzf openbuild-v0.2.0.tar.gz && cd openbuild && npm ci --omit=dev && npm start
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(unset → PGlite)* | `postgres://user:pass@host:5432/db` |
| `PGLITE_DIR` | `./data/pglite` | Embedded database directory |
| `OPENBUILD_STORAGE_DIR` | `./data/files` | Uploaded files |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address (`0.0.0.0` in Docker) |
| `OPENBUILD_ALLOW_SIGNUP` | `true` | Set `false` after creating your company so strangers cannot register |
| `OPENBUILD_SECURE_COOKIES` | `false` | Set `true` when served over HTTPS (required in production) |
| `OPENBUILD_BASE_URL` | — | Public URL, used in emailed links, e.g. `https://build.example.com` |
| `OPENBUILD_SMTP_URL` | — | e.g. `smtps://user:pass@smtp.example.com:465`; enables email for invitations, resets and notifications |
| `OPENBUILD_MAIL_FROM` | `OpenBuild <no-reply@localhost>` | Sender address |
| `OPENBUILD_S3_BUCKET` | — | Store files in S3-compatible storage instead of local disk; also `OPENBUILD_S3_REGION`, `OPENBUILD_S3_ENDPOINT` (MinIO/R2/B2), `OPENBUILD_S3_ACCESS_KEY_ID`, `OPENBUILD_S3_SECRET_ACCESS_KEY`, `OPENBUILD_S3_FORCE_PATH_STYLE`, `OPENBUILD_S3_PREFIX` |
| `OPENBUILD_OIDC_ISSUER` | — | Enables single sign-on; with `OPENBUILD_OIDC_CLIENT_ID`, `OPENBUILD_OIDC_CLIENT_SECRET`, `OPENBUILD_OIDC_NAME` (button label). Requires `OPENBUILD_BASE_URL`; register `<base>/api/auth/oidc/callback` as the redirect URI |
| `OPENBUILD_SAML_ENTRY_POINT` | — | SAML 2.0 single sign-on instead of OIDC; with `OPENBUILD_SAML_IDP_CERT` (IdP signing certificate) and `OPENBUILD_SAML_NAME`. Requires `OPENBUILD_BASE_URL`. SP metadata: `<base>/api/auth/saml/metadata`, ACS: `<base>/api/auth/saml/acs` |
| `OPENBUILD_DOC_TOOLS` | `[{"id":"opendraft","name":"OpenDraft"}]` | Markup tools; see [INTEGRATIONS.md](INTEGRATIONS.md) |

## Production checklist

1. Put OpenBuild behind HTTPS (Caddy, nginx, Traefik) and set `OPENBUILD_SECURE_COOKIES=true`.
2. Set `OPENBUILD_ALLOW_SIGNUP=false` once your company exists; add people with invitations.
3. Configure SMTP so invitations and password resets are emailed.
4. Schedule backups (below) and test a restore.
5. Run a single app instance per database (login rate limiting is in-memory; see Known limitations).

## Backups and recovery

```sh
# stop the app (or accept a crash-consistent copy of uploaded files), then:
npm run backup --workspace apps/api -- backup  /backups/2026-10-22
npm run backup --workspace apps/api -- restore /backups/2026-10-22   # into an EMPTY database
```

A backup is `database.json` (every table, dumped in one consistent transaction) plus a copy of the file store.
It is driver-independent: you can back up from PGlite and restore into PostgreSQL to migrate.
Restore refuses to run against a database that already has users.

The recovery drill `node scripts/smoke.mjs` (run in CI against both PGlite and PostgreSQL) does: fresh install → create data
→ **hard kill** → restart and verify → CLI backup → restore into a brand-new installation → verify login, records and files.

With Docker Compose you can also use `pg_dump` on the `db` service plus a copy of the `files` volume.

## Upgrades

Migrations run automatically at startup (`schema_migrations` records what has been applied). They are append-only; take a backup before upgrading.

## Inbound project email (optional)

On a project's Emails tool, a manager chooses **Set up inbound email** to get a one-time secret URL
(`/api/inbound-email/<token>`). Configure your mail provider's inbound webhook (Mailgun routes, Postmark inbound,
SendGrid Inbound Parse via a small mapping) to POST JSON `{ "from", "to", "cc", "subject", "text" }` there. Replies
whose subject keeps the `[#E-n]` tag join thread n. Setting it up again replaces the secret.
