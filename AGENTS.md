# Finto

A hosted personal finance tracker. A person signs up, uploads bank statements in whatever format
they happen to have, and gets their financial data organised and readable.

**The import promise: one upload button.** CSV, XLSX, PDF — the user should never have to know or
care which parser runs.

**Platforms.** The web client is the product being built now. Native iOS and Android come later,
which is why the REST API — not the React app — is the real contract: no logic that a mobile
client cannot reach, no state that lives only in the browser.

## What is in this file, and what is not

This is the durable half: layout, commands, the invariants, and the shape of what the test suite
cannot see. It is the file to read before changing anything.

Two things it deliberately does not carry. **Counts** — how many tests, which tip they were
measured on — live in a working file outside the repository, because a number published here is
wrong by the next merge. And **the plan** — the order of work, the open findings — is not in the
public tree either; `ROADMAP.md` and `DEBT.md` are referenced by `.agents/README.md` and are not
files you are missing. Nothing here depends on them.

## Layout

```
backend/    Express 5 + TypeScript, Drizzle ORM over PostgreSQL, better-auth, Zod, pino
  src/db/       schema.ts, index.ts (queries), dedup.ts, workspace.ts
  src/providers/ statement.ts (the one ingestion surface), csv.ts, xlsx.ts, sheet.ts
  drizzle/      migrations, currently a single squashed 0000_initial.sql
  test/         vitest + pglite + supertest; helpers.ts and pglite.ts are the harness
web/        React 19 + Vite + Recharts
  src/screens/  Overview, Transactions, Analytics, Independence, Auth
```

`.agents/README.md` is how a task is run — the pipeline, and which checks are worth trusting.
`ARCHITECTURE.md` is the module map and the path one statement takes through it. `SECURITY.md` is
the threat model.

## Commands

Run from `backend/` unless stated otherwise.

```
npm run typecheck     tsc --noEmit          both packages have this
npm test              vitest run            both packages have this
npm run dev           tsx watch src/index.ts
npm run db:generate   drizzle-kit generate
cd web && npm run dev
```

Verification means both `npm run typecheck` and `npm test` green in `backend/`. A change is not
finished on a claim that they pass — run them.

`typecheck` covers `src` and `scripts` only — `tsconfig.json`'s `include` does not list `test`, and
vitest strips types without checking them. So a change confined to test files is verified by the
suite alone, and "typecheck clean" says nothing about it.

## Invariants

- **Workspace scoping.** Every row belongs to a workspace (`organization.id`). The workspace is
  carried implicitly through `AsyncLocalStorage` (`src/db/workspace.ts`), never as a parameter.
  Outside a workspace context, production code throws rather than querying. **Every new query
  must be scoped** — `test/workspace-scope.test.ts` and `test/tenant-isolation.test.ts` exist to
  catch this and are not optional.
- **Transaction identity.** `transactions.id` is a surrogate UUID; deduplication runs off a
  separate computed key with a per-group ordinal (`src/db/dedup.ts`). Ordinals stay dense across
  a delete. Do not conflate the two keys.
- **Import provenance.** Every transaction carries `import_id`. `imports` is uniquely indexed on
  `(workspace_id, file_hash) WHERE status = 'committed'` — only `committed` means the rows are
  actually in the database, so only `committed` may block a re-upload.
- **Migrations are squashable until first deploy.** Nothing is deployed, so migration history has
  no value yet: three schema changes are one regenerated `0000_initial.sql`. That stops being
  true the day real user data exists. **A squash invalidates every database already migrated:**
  the regenerated file carries a later `_journal.json` timestamp, so drizzle re-applies it and the
  run dies with `42P07 relation already exists`. Every local database — dev and `*_test` — has to
  be dropped and recreated after one.
- **Categories are slugs** in the database and over the API; display names live in the client
  dictionary. The slug is a stable contract.
- **Secrets live in `.env`**, everything else configurable lives in the `settings` table.
- **A diagnostic is not delivered until it survives every cap between composition and screen.**
  `ERROR_DETAIL_MAX` bounds what reaches `imports.error_detail`, and `web/src/api.ts` shows that
  whole budget. So ordering decides which clause is *dropped*, not which is read: compose
  actionable text first and let refinements yield, and include an appended clause whole or not at
  all — never cut mid-token, since a truncated tail names things that do not exist. Before
  trusting either number, read them; both have moved once already.
- **Silent success is the failure mode that matters.** A crash is recoverable; a 200 answer on
  data the user did not upload, or a partial import reported as complete, is not. Where a choice
  is between refusing loudly and proceeding quietly, refuse.

## Verification has a hole

`web/` runs two vitest projects, split by filename so the environment cannot be got wrong: `unit`
(`src/**/*.test.ts`, node, no DOM — formatting, the slug dictionaries, how a failed request becomes
a sentence) and `dom` (`src/**/*.test.tsx`, jsdom + React Testing Library). Any request to a route
the test did not declare fails that test.

What jsdom cannot see is a limit of the environment, not a gap waiting to be filled: no layout and
nothing from `styles.css`, so the only visibility fact available is the `hidden` attribute; no real
navigation and no download, so whether a file lands on disk is unanswerable here; no chart
rendering — recharts measures a 0×0 box, so a test can mount a donut and assert nothing about it.
Those checks stay manual, and an agent can run them: a real Chrome is reachable through the
`claude-in-chrome` tools, and each check is recorded with how it was observed (`.agents/README.md`,
and rule 9 in `.claude/agents/reviewer.md`). The carve-out is **`⬇ Download backup (.json)`**, which
stays the maintainer's — it writes every transaction in the workspace to a file, and that is not an
export an agent runs on anyone's behalf.

Several screens and both shared controls are mounted by a test and asserted about by nothing:
mounting is not coverage, and `Sheet`'s and `Chips`' own behaviour — the backdrop, Escape, focus,
`aria-pressed` — is nowhere. Each stays unverified until someone clicks through it, and **an
unrecorded click leaves it unverified too**, because nothing downstream can tell that run from one
that never happened. Say which screens a green run covered rather than implying it covered `web/`.

The backend suite runs on embedded PGlite by default and on a real Postgres when
`TEST_DATABASE_URL` is set (CI does both). PGlite is single-connection, so nothing about
concurrency — a unique index losing a race, two writers meeting — is exercised by the default
run. The suite truncates every table in the database it is given and refuses one not named
`*_test`.

One backend test never runs on Windows or as root: `test/documents.test.ts` skips there, so a green
local run on either is one short of the total. It is the boot check that a document root which
exists but cannot be written to is refused, and CI (ubuntu, non-root) is the only place it fires.
Nothing else skips — `canvasabsent.test.ts` hides the package in a spawned child and runs
everywhere.

## Conventions

- **Comments are sparse.** The existing density is low and deliberate — comments explain *why* a
  non-obvious decision was made (see the header of `src/db/workspace.ts`), never what the code
  already says. Do not annotate obvious lines.
- Match the style, naming and idiom of the file being edited.
- **Never commit, push, or `git add` without being asked.** Work is left in the working tree; the
  human commits.
