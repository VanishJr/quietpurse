# backend/src/db

Status: reviewed

What this module is for, where it stops, and the rules about it that no type and no test holds.
Everything already enforced beside the code it governs stays there: `AGENTS.md`'s *Invariants*
carry workspace scoping, transaction identity, import provenance and the migration-squash rule, and
the headers of `backend/src/db/schema.ts`, `backend/src/db/workspace.ts` and
`backend/src/db/dedup.ts` carry the reasoning behind the constraints they declare. Nothing below
repeats them.

## What this module owns

- **The schema, and through it the migrations.** `drizzle-kit generate` diffs
  `backend/src/db/schema.ts` into the migration directory; this module applies what is there when
  the server connects. Generation is a command a person runs, application is not.
- **Every finance query the app makes**, each scoped to the workspace carried in
  `backend/src/db/workspace.ts` rather than passed as an argument.
- **The deduplication key format** (`backend/src/db/dedup.ts`), which is a shared format rather than
  a private one: a script outside this module reconstructs the same keys.
- **The diagnostic budget** for a failed import. What holds it is
  `backend/test/error-budget.test.ts`, which reads the client's own cap as source, because the two
  packages share no build.

## Where the boundary runs

Nothing in `backend/src` outside this directory imports the ORM. That is the boundary as measured,
and **nothing enforces it** — no check refuses the next file that imports it, so the sentence is
true today and holds nothing about tomorrow.

The crossings below exist and each of them is deliberate. Nothing holds that list either:

- **`backend/src/auth.ts`** imports the schema and inserts the workspace and membership rows
  itself, and hands better-auth's drizzle adapter the same handle. The adapter issues its own SQL
  against the auth tables, which this module never sees. Neither path is workspace-scoped: one
  *creates* the workspace a context could name, and the tables the adapter writes are not scoped by
  a workspace at all.
- **`backend/scripts/migrate-sqlite-to-pg.ts`** builds its own handle, applies migrations itself,
  and reconstructs deduplication keys for a history imported from the SQLite era. What a
  disagreement between the two costs is stated where the key format lives.
- **The handle is exported.** A query written through it is a query outside this module, and it
  carries no workspace filter unless its author writes one — which is exactly what the isolation
  tests rely on to plant another workspace's rows where a scoped query must not find them.

So the honest statement of ownership is: this module owns the finance data. It does not own the
auth and workspace tables' writes, and it does not own what the migration script does.

## The invariants no type and no test holds

**Adding a workspace-scoped table means editing lists by hand, and nothing connects any of them to
`backend/src/db/schema.ts`.** They are `BACKUP_TABLES` in `backend/src/db/index.ts`, which decides
what a backup contains; the table set exercised by `backend/test/tenant-isolation.test.ts`, whose
header states that it is kept equal to the first by reading; the enumeration in
`backend/test/workspace-scope.test.ts`, which its own comment admits is hand-written; and `TABLES`
in `backend/test/pglite.ts`, the truncate list. Nothing holds that list of lists either, so another
may exist and be named nowhere. Missing one is silent in the direction that matters: the export
succeeds, the restore succeeds, and what the reader built is in neither.

**`settings` and `meta` are the same shape, and which one a value belongs in is a convention with
no enforcement.** `settings` holds what a person edits about their workspace, such as
`base_currency` and `owner_names`. `meta` holds what the server keeps about itself, a stamp it
compares against on the next start or the next write. The exception is the one a reader adding a
value will get wrong: the Goal screen's configuration is a person's, and it lives in `meta` as one
JSON blob under the key `settings`. A new setting written to the table of that name is not where
the existing ones are.
