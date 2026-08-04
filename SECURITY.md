# Security Policy

## Status

Finto is **pre-release and not deployed anywhere**. There is no published version, no upgrade path,
and no user data outside whatever a developer put in their own database. `main` is the only branch
that receives fixes.

That is also why this document states open trade-offs rather than only closed ones: the point of
writing them down now is that the deployment decision is still ahead.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). Please include what you did, what happened, and what you
expected. Since nothing is hosted, a report against a local checkout is the only kind there is —
say which commit.

## What the application is protecting

Bank statements. The threat that matters is not downtime; it is **one workspace's transactions
appearing in another's answer**, and **a stored statement being readable by someone who reached the
disk**. Everything below is ordered by that.

## Threat model

| Vector | Mitigation |
|---|---|
| One tenant reading another's data | Every table carries `workspace_id`, with composite primary key `(workspace_id, id)` so that colliding ids across workspaces are legal and a query filtering on `id` alone breaks loudly instead of silently. `test/tenant-isolation.test.ts` seeds two workspaces with deliberately colliding identifiers |
| A query written without a scope | The scope is not a parameter: `db/workspace.ts` carries it in `AsyncLocalStorage`, and `currentWorkspaceId()` **throws** outside a context rather than falling back. A new unscoped query fails its first test rather than returning someone else's rows. `test/workspace-scope.test.ts` covers the mechanism itself |
| Stored statements read off the disk | Documents are sealed with **AES-256-GCM**, key derived by **HKDF-SHA256** from `DOCUMENT_ENCRYPTION_KEY` with a per-document random IV and an authentication tag (`src/documents.ts`). A key-version byte is stored alongside so a future rotation can tell sealed generations apart |
| Booting production on development defaults | `assertProductionConfig()` (`src/config.ts:123`) refuses to start under `NODE_ENV=production` on any of four: the public dev session secret, a non-https `BETTER_AUTH_URL`, the public dev document key, or the default compose database password. It throws with the generation command in the message |
| Forged session cookies | Sessions are better-auth cookie sessions signed with `BETTER_AUTH_SECRET`; the dev fallback is public and the backend warns at startup and refuses in production |
| A stale or revoked session still answering | The session row is read from the database on **every** request (`src/app.ts:165`) — no cookie cache, so revocation takes effect immediately. It costs two round trips before the handler, which is the side of that trade to be on |
| Request body parsed before the caller is known | `express.json` is mounted at `src/app.ts:216`, **after** the session middleware at `:160`. An unauthenticated request is refused without its body ever being parsed |
| Cross-origin credentialed requests | Exact-origin echo from the `CORS_ORIGINS` allowlist with `Vary: Origin` — never a wildcard, which browsers forbid with credentials anyway (`src/app.ts:98`). Same-origin setups skip it entirely |
| Open registration on a reachable server | `SIGNUP_INVITE_CODE`, when set, requires the `x-invite-code` header on `/api/auth/sign-up` and answers 403 without it (`src/app.ts:127`) |
| Unintended auth surface from a plugin | better-auth's organization plugin is mounted for its schema and membership model, which also publishes roughly 30 endpoints — create, delete, invite-member. All of `/api/auth/organization` answers a blanket **404** until multi-user workspaces are actually built (`src/app.ts:138`) |
| Credential stuffing / brute force | better-auth rate limits: 5 per 60s on `/sign-in/email`, 10 per hour on `/sign-up/email`, 100 per 60s globally (`src/auth.ts:90`). **Counters are per-process and in memory** — see the open trade-offs below |
| Oversized or malicious uploads | multer caps a single upload at **25 MiB** (`src/app.ts:828`), and `providers/statement.ts` applies a second, per-format cap plus a 200-page ceiling on PDFs — the expansion-sensitive formats are bounded after decode, not only before |
| Format confusion in the parser | `sniff()` decides the format from bytes, never the filename or the client's content type. It recognises a format on **evidence that the format is present**, never on the absence of others — including the signed-container case where `%PDF-` sits at byte 71 |
| A half-understood statement importing silently | Nothing is committed on upload. `POST /api/imports` stages; rows reach `transactions` only on an explicit `confirm`. A reconciliation gate refuses rather than importing part of a file |
| Duplicate or replayed imports | `imports` is uniquely indexed on `(workspace_id, file_hash) WHERE status = 'committed'`, so a committed file cannot be silently re-imported, while a discarded one does not block a retry |
| Secrets in the image or the repo | Secrets live only in `.env`. `.gitignore` refuses `.env*`, `backend/secrets/`, `*.csv`, `*.pdf` and the database files outright; `web/` ships no credential of any kind. The Dockerfile mounts `secrets/` as a volume and bakes nothing |

## Open trade-offs

Stated because they are decisions, not oversights. Each one is a thing to fix before this is hosted
for anyone but its author.

- **Tenant isolation is enforced by application code, not by the database.** There is no Postgres
  row-level security. The composite key and the throwing scope make a mistake loud, and two tests
  exist to catch the class — but a query that reaches the database without a scope is prevented by
  `db/workspace.ts`, not by the server. RLS as a second layer is an open question, not a plan.
- **The rate limiter is per-process and in memory.** A restart clears the sign-in counter, and two
  instances behind one address each get their own budget. This is the only brute-force defence on
  the sign-in route.
- **Registration is open by default.** `SIGNUP_INVITE_CODE` is empty unless set, so anyone who can
  reach the server can create a workspace. Intentional for a single-user local run; wrong the
  moment the port is reachable.
- **The production image runs TypeScript through `tsx` with devDependencies installed.** No build
  step, so the transformer and the test tooling are present in the running image. Deliberate for
  now, recorded, and not a shape to deploy behind a public address.
- **Migrations are applied at container start.** Correct for one container, a race for two.
- **The default test run cannot see a concurrency bug.** PGlite is single-connection, so a unique
  index losing a race is exercised only when `TEST_DATABASE_URL` points at a real Postgres. CI does
  both; a local run usually does not.

## What Finto does not do

- Does not send financial data anywhere. There is no telemetry, no analytics, and no third-party
  request in the transaction path.
- Does not hold bank credentials or API tokens. Direct bank connections were removed; a statement
  is a file the user uploads.
- Outbound network access is limited to exchange-rate providers (ECB, NBU) for currency conversion.
- Does not store a secret in the browser. The client holds a cookie session and nothing else.
