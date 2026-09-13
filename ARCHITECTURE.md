# Architecture

Finto is an Express API over Postgres with a React client, and one person runs the whole of it on
their own machine: the database is PGlite, Postgres compiled to run inside the Node process, and it
lives in a folder beside the statements the person uploaded. The API is the contract — the web
client is one consumer of it, and native clients are planned — so nothing that decides an outcome
lives in `web/`.

Two things shape the rest of this document: **the data is one folder on one person's disk**, and
**one upload button hides every parser**. Most of what looks like indirection below is one of those
two.

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
| `app.ts` | The Express app: every route, the body parsers, and the built client served below them. Separate from `index.ts` so the whole route table is testable over real HTTP |
| `index.ts` | Process start: the lock (`lock.ts`), the writable-folder check, open and migrate, seed, listen on loopback, close on Ctrl+C |
| `lock.ts` | The one-process-per-folder lock: the claim by exclusive create, what a file already there means, the serialised takeover of a stale one, and a release that removes only its own pid |
| `config.ts` | `.env` reading with a working default for everything — the folder, the port, the host — and the one setting that swaps the engine, `DATABASE_URL` |
| `db/schema.ts` | Drizzle table definitions. The source the migrations are generated from |
| `db/index.ts` | Opening the database — PGlite in the folder, or a PostgreSQL server — and every query. Raw `sql` templates, not the Drizzle query builder — so renaming a column in `schema.ts` breaks at runtime, not at build. Known, and deliberate for now: the SQL arrived written, from the SQLite era |
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
| `documents.ts` | Uploaded statements as plain files in the statements folder: the name a file gets, `putDocument`/`getDocument`/`deleteDocument`, and the hash check on read |
| `storage.ts` | The object store underneath `documents.ts`: an atomic write, and a key shape that refuses rather than cleans |
| `settings.ts` / `appsettings.ts` | The person's settings in the database |

`web/src/screens/` holds Overview, Transactions, Analytics, Independence and Settings;
`web/src/api.ts` is the only place that talks to the API, and it also owns how a failed request
becomes a sentence.

## One person, one folder

Everything the app keeps is under `FINTO_HOME`, `~/Finto` by default:

```
~/Finto/
  db/            the PGlite data directory
  statements/    <stem>_<import id>.<csv|xlsx|pdf> — the uploaded bytes, plain
  finto.lock     the running process's pid
```

There is no sign-in and no tenant. Whoever can reach the port owns the data behind it, so
`index.ts` binds the loopback interface unless told otherwise, and no query carries an owner: the
whole table is the person's. What that deleted from the data layer was one column on every table, a
composite key over it, and the request context that carried it; what it left is a database any
query reads whole.

PGlite does not refuse a second process on the same directory — two writers corrupt it with nothing
failing — so the lock file is the guard: taken before the database is opened, refused while a live
pid holds it, taken over from a dead one, removed on the way out. A PostgreSQL server, when
`DATABASE_URL` names one, brings its own locking and the file is not written.

`SECURITY.md` states plainly what this shape does and does not protect.

## Two keys that are not the same key

- `transactions.id` — a surrogate UUID. Identity for the API and for foreign keys.
- The **computed dedup key** (`db/dedup.ts`) — derived from the statement row's own content, with a
  per-group ordinal so that a statement legitimately containing the same charge twice keeps both.
  Ordinals stay dense across a delete.

Conflating them re-introduces the duplicate-import bug in whichever direction you got it wrong.

## Import provenance

Every transaction carries `import_id`. `imports` is uniquely indexed on
`file_hash WHERE status = 'committed'` — the partial predicate is the point: a staged or discarded
import must not block re-uploading the same file, and only `committed` means the rows are really in
the database.

## Migrations

`db/schema.ts` is the source; SQL is generated from it with `npm run db:generate` into
`backend/drizzle/` and applied when the database is opened. Until the first release the history is
squashed into a single `0000_initial.sql` on every schema change — the history has no databases to
upgrade. **A squash invalidates every database already migrated**, `~/Finto/db` and every `*_test`
one, because the regenerated file carries a later journal timestamp and drizzle re-applies it. From
the first release on, migrations are append-only and an applied one is never edited.

## Adding a statement format

1. Write the parser in `providers/`, returning rows through the shared `sheet.ts` cell readers if
   it is grid-shaped.
2. Add the type to `ImportSourceType` and teach `sniff()` to recognise it **from bytes**. Recognise
   on evidence the format is present, never on the absence of other formats.
3. Give it an entry in `PARSER_VERSION`, `SIZE_CAP` and `FORMAT_NAME` in `statement.ts` — the last
   one feeds the refusal text that lists what the app accepts, so a format the user cannot be told
   about is a format they cannot be refused clearly for. The type's name is also the extension a
   stored statement gets, so it has to be one a file can carry.
4. Add fixtures. PDF fixtures are built in code (`test/pdffixture.ts`) rather than committed, since
   `.gitignore` refuses `*.pdf` and `*.csv` outright.

## Testing

`backend/` runs vitest against an embedded PGlite in memory by default — the engine the product
itself runs on — and against a real Postgres when `TEST_DATABASE_URL` is set; CI does both. PGlite
is single-connection, so the default run proves nothing about concurrency — a unique index losing a
race is not exercised there. `test/setup.ts` runs once per test file, so every table is truncated
before each one; it refuses a database not named `*_test`, and it points the statements folder at
a temporary directory so nothing a test uploads reaches `~/Finto`.

`web/` runs two vitest projects split by filename so the environment cannot be got wrong: `unit`
(`*.test.ts`, node) and `dom` (`*.test.tsx`, jsdom). What jsdom structurally cannot check — layout,
downloads, chart rendering — is listed in `AGENTS.md` under "Verification has a hole", along with
what is done about it.
