# Architecture

Finto is an Express API over PostgreSQL with a React client. The API is the contract — the web
client is one consumer of it, and native clients are planned — so nothing that decides an outcome
lives in `web/`.

Two things shape the rest of this document: **every row belongs to a workspace**, and **one upload
button hides every parser**. Most of what looks like indirection below is one of those two.

## The one ingestion surface

A statement enters through a single door, whatever format it is in:

```
POST /api/imports  ──▶  sniff(bytes)  ──▶  importStatement(...)  ──▶  a staged import
                            │                      │
                            │                      ├─ csv.ts     decodeCsv → parseCsv
                            │                      ├─ xlsx.ts    readXlsx  ─┐
                            │                      └─ pdf.ts     readPdf   ─┴─ sheet.ts (cell reads)
                            │
                            └─ decides the format from the bytes, never from the filename

POST /api/imports/:id/confirm  ──▶  rows land in `transactions`
POST /api/imports/:id/discard  ──▶  the staged import is dropped
```

`providers/statement.ts` is the surface. Callers do not choose a parser and cannot: `sniff()` reads
the bytes and returns an `ImportSourceType`, and everything after it — size caps, page caps, the
reconciliation gate, the refusal wording — is keyed off that one value.

**Nothing is committed on upload.** `POST /api/imports` parses, reconciles and stages; the rows
exist for the user to look at and are not in `transactions` until `confirm`. That split is what
makes the failure mode of a half-understood statement a refusal the user reads rather than a
partial import they do not notice.

### Why `sniff` reads bytes and not the extension

A bank's own export can be a signed container — the statement inside a CMS envelope, with `%PDF-`
at byte 71 rather than byte 0. A CSV whose first cell is a date starts with an ASCII digit that is
also a valid ASN.1 tag. The comments inside `sniff` in `providers/statement.ts` carry the full
reasoning, including which byte parts the two cases and why the rule is narrow on purpose. Read
them before touching that function; every clause in it was paid for by a document that broke the
previous one.

## Modules

`backend/src/`

| Module | What it owns |
|---|---|
| `app.ts` | The Express app: every route, CORS, the session middleware, the workspace scope per request. Separate from `index.ts` so the middleware chain is testable over real HTTP |
| `index.ts` | Process start: config assertions, migrations, listen |
| `auth.ts` | better-auth wiring — email/password, cookie sessions, the organization plugin that workspaces are built on, rate limits |
| `config.ts` | `.env` reading plus `assertProductionConfig()`, which refuses to boot production on a dev default |
| `db/schema.ts` | Drizzle table definitions. The source the migrations are generated from |
| `db/index.ts` | Every query. Raw `sql` templates, not the Drizzle query builder — so renaming a column in `schema.ts` breaks at runtime, not at build. Known, and deliberate for now: the SQL arrived written, from the SQLite era |
| `db/workspace.ts` | The `AsyncLocalStorage` that carries the current workspace. `currentWorkspaceId()` throws outside a context |
| `db/dedup.ts` | The computed dedup key and its per-group ordinal — distinct from `transactions.id` |
| `providers/statement.ts` | The ingestion surface: `sniff`, `importStatement`, `readSheet`, `reconcile` |
| `providers/csv.ts` | Delimiter detection, encoding, column matching, the bank presets |
| `providers/xlsx.ts` | Workbook reading through exceljs |
| `providers/pdf.ts` | Layout templates and text-layer extraction |
| `providers/pdfjsloader.ts` | Installs `DOMMatrix`/`Path2D` stubs before pdfjs loads — without them `pdf.mjs` does not evaluate at all under Node |
| `providers/sheet.ts` | Cell-level reads shared by the xlsx and pdf paths (`cellDate`, `cellAmount`, …) |
| `categorizer.ts` | MCC and description rules → a category slug; refund and recurrence detection |
| `classify.ts` | Transfer pairing between the user's own accounts, and re-classification when rules change |
| `independence.ts` | The self-sufficiency computation |
| `fxrates.ts` / `rates.ts` | ECB and NBU providers, rate resolution, backfill of base-currency amounts |
| `money.ts` | Cents in, cents out. Money is integer cents everywhere below the API |
| `documents.ts` | Uploaded statements sealed on disk: key derivation, `sealDocument`/`openDocument`, key versioning |
| `storage.ts` | The object store underneath `documents.ts` |
| `settings.ts` / `appsettings.ts` | Per-workspace settings in the database |

`web/src/screens/` holds Overview, Transactions, Analytics, Independence and Auth; `web/src/api.ts`
is the only place that talks to the API, and it also owns how a failed request becomes a sentence.

## Workspace scoping

Every data table has a `workspace_id`, and the composite primary key `(workspace_id, id)` makes it
legal for the same `id` to exist in two workspaces — which is exactly the case that breaks a query
filtering on `id` alone. `test/tenant-isolation.test.ts` deliberately gives two workspaces
colliding identifiers.

The scope is **not a parameter**. The session middleware puts it into `AsyncLocalStorage` per
request and background work sets it per workspace; `db/index.ts` reads it from there. A query that
runs with no scope throws rather than returning someone else's rows — that throw is the mechanism,
and `test/workspace-scope.test.ts` is what keeps it honest.

The trade-off is stated plainly in `SECURITY.md`: isolation is enforced by application code, not by
Postgres row-level security.

## Two keys that are not the same key

- `transactions.id` — a surrogate UUID. Identity for the API and for foreign keys.
- The **computed dedup key** (`db/dedup.ts`) — derived from the statement row's own content, with a
  per-group ordinal so that a statement legitimately containing the same charge twice keeps both.
  Ordinals stay dense across a delete.

Conflating them re-introduces the duplicate-import bug in whichever direction you got it wrong.

## Import provenance

Every transaction carries `import_id`. `imports` is uniquely indexed on
`(workspace_id, file_hash) WHERE status = 'committed'` — the partial predicate is the point: a
staged or discarded import must not block re-uploading the same file, and only `committed` means
the rows are really in the database.

## Migrations

`db/schema.ts` is the source; SQL is generated from it with `npm run db:generate` into
`backend/drizzle/` and applied at startup. Until the first real deployment the history is squashed
into a single `0000_initial.sql` on every schema change — the history has no databases to upgrade.
**A squash invalidates every database already migrated**, including `*_test` ones, because the
regenerated file carries a later journal timestamp and drizzle re-applies it. From the first
deployment on, migrations are append-only and an applied one is never edited.

## Adding a statement format

1. Write the parser in `providers/`, returning rows through the shared `sheet.ts` cell readers if
   it is grid-shaped.
2. Add the type to `ImportSourceType` and teach `sniff()` to recognise it **from bytes**. Recognise
   on evidence the format is present, never on the absence of other formats.
3. Give it an entry in `PARSER_VERSION`, `SIZE_CAP` and `FORMAT_NAME` in `statement.ts` — the last
   one feeds the refusal text that lists what the app accepts, so a format the user cannot be told
   about is a format they cannot be refused clearly for.
4. Add fixtures. PDF fixtures are built in code (`test/pdffixture.ts`) rather than committed, since
   `.gitignore` refuses `*.pdf` and `*.csv` outright.

## Testing

`backend/` runs vitest against embedded PGlite by default, and against a real Postgres when
`TEST_DATABASE_URL` is set; CI does both. PGlite is single-connection, so the default run proves
nothing about concurrency — a unique index losing a race is not exercised there. The suite
truncates every table in the database it is given and refuses one not named `*_test`.

`web/` runs two vitest projects split by filename so the environment cannot be got wrong: `unit`
(`*.test.ts`, node) and `dom` (`*.test.tsx`, jsdom). What jsdom structurally cannot check — layout,
downloads, chart rendering — is listed in `AGENTS.md` under "Verification has a hole", along with
what is done about it.
