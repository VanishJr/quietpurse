---
id: architecture
type: architecture-design
status: draft
title: The Quietpurse module map and the path one statement takes through it
---

Quietpurse is an Express API over Postgres with a React client, and one person runs all of it on
their own machine. The database is PGlite, Postgres compiled to run inside the Node process, kept in
a folder next to the uploaded statements. The API is the contract: the web client is one consumer,
and native clients are planned. So nothing that decides an outcome lives in `web/`.

Two things shape the rest: **the data is one folder on one person's disk**, and **one upload button
hides every parser**.

## The one ingestion surface

```
POST /api/imports
  └─ importStatement(...)        backend/src/providers/statement.ts
       ├─ already committed?     answered as a duplicate, nothing else is read
       ├─ sniff(bytes)           the format, from the bytes, never from the filename
       ├─ the format's size cap, then the uploaded file is stored
       ├─ readSheet(...)         every format becomes one Sheet
       │    ├─ csv   backend/src/providers/csv.ts    decodeCsv, then parseCsv
       │    ├─ xlsx  backend/src/providers/xlsx.ts   readXlsx
       │    └─ pdf   backend/src/providers/pdf.ts    readPdf
       └─ one loop reads every row, reconciles, and stages the import

POST /api/imports/:id/confirm   the staged rows land in `transactions`
POST /api/imports/:id/discard   the staged rows are dropped; the import stays, as `discarded`
```

Callers do not choose a parser and cannot. `sniff()` returns an `ImportSourceType`, and the size cap,
the PDF page cap and the parser follow from it. The row loop reads every format through the cell
readers in `backend/src/providers/sheet.ts`. Reconciliation depends on the kind of file, a sheet
(CSV or XLSX) or a PDF.

**Nothing is committed on upload.** The rows wait for the person to review them and reach
`transactions` only on `confirm`. So a statement the parser half understood ends in a refusal the
person reads, not in a partial import they miss.

### Why `sniff` reads bytes and not the extension

A bank's export can be a signed container, a CMS envelope with `%PDF-` at byte 71, and a CSV whose
first cell is a date starts with a byte that is also a valid ASN.1 tag. The policy is in
`backend/src/providers/SPEC.md` under *Responsibility*, and the byte-level reasoning is the comment
above the container test inside `sniff`: read it before touching the function.

## Modules

| Module | What it owns |
|---|---|
| `backend/src/app.ts` | Every route, the body parsers, the built client. Separate from `backend/src/index.ts` so the routes can be tested over real HTTP |
| `backend/src/wire/` | Every route's answer as zod schemas, sent with each currency in one form, and the vocabularies and bounds the client builds against. The backend infers its types from it; the client imports them type-only and pins its copies of the bounds to them. Imports only zod |
| `backend/src/index.ts` | Start: the lock, the writable-folder check, open and migrate, seed, listen. A recompute runs in the background so the start does not wait for exchange rates. Ctrl+C or SIGTERM closes everything |
| `backend/src/lock.ts` | One process per folder: the claim by exclusive create, the takeover of a stale lock under a marker, and a release that removes only its own pid |
| `backend/src/config.ts` | `.env`, with a working default for everything; `DATABASE_URL` swaps the engine |
| `backend/src/db/schema.ts` | Drizzle tables, the source of the migrations |
| `backend/src/db/index.ts` | Opens the database (PGlite or a server) and holds every query. Some are raw `sql`, which a column renamed in `backend/src/db/schema.ts` breaks only at runtime, not at build. Known and kept for now: that SQL came from the SQLite era |
| `backend/src/db/dedup.ts` | The computed dedup key and its per-group ordinal |
| `backend/src/providers/statement.ts` | The ingestion surface: `sniff`, `importStatement`, `readSheet`, `reconcile` |
| `backend/src/providers/csv.ts` | Delimiters, encodings, column matching, bank presets |
| `backend/src/providers/xlsx.ts` | Workbooks, through exceljs |
| `backend/src/providers/pdf.ts` | Layout templates and text-layer extraction |
| `backend/src/providers/issuer.ts` | The issuer of a PDF no template matched, from the IBANs it prints |
| `backend/src/providers/pdfjsloader.ts` | `DOMMatrix` and `Path2D` stubs. Without them pdfjs does not load under Node unless its optional native canvas package is installed |
| `backend/src/providers/sheet.ts` | The cell readers every format shares |
| `backend/src/categorizer.ts` | MCC and description rules to a category slug, refunds, the key recurring payments are grouped by |
| `backend/src/classify.ts` | Transfers between the person's own accounts, recurring payments, re-classification when rules change |
| `backend/src/transaction-description.ts` | The second reading of a stored description: the value-date suffix, the similarity key, and one predicate per rule kind, shared by the classifier, the previews and the counts |
| `backend/src/goals.ts` | Every goal's progress, in one batch. The API owns every goal figure and the client only formats it. A new installation has no goals until the person creates one |
| `backend/src/fxrates.ts`, `backend/src/rates.ts` | The ECB's rates (through Frankfurter) and the NBU's, and the backfill of base-currency amounts. Monobank's public rates, for the classifier's check of cross-currency transfers |
| `backend/src/currency.ts` | ISO 4217 numeric codes to letter codes, the pattern a letter code must match wherever one enters, and the one form two currencies are compared in |
| `backend/src/money.ts` | Decimal amounts to integer cents and back. Amounts are stored and reconciled in cents |
| `backend/src/documents.ts` | Stored statements: a file's name, `putDocument`, `getDocument`, `deleteDocument`, the hash check on read |
| `backend/src/storage.ts` | The file store under it: an atomic write, and a key shape that refuses rather than cleans |
| `backend/src/appsettings.ts` | The person's global settings in the database |
| `backend/src/logger.ts` | The pino logger and a child per area |
| `backend/src/types.ts` | The backend's domain types, mostly re-exported from the wire |

`web/src/screens/` holds Overview, Transactions, Analytics, Goals and Settings. `web/src/api.ts` is
the only place that talks to the API, and turns a refused request into a sentence. `web/src/types.ts`
is the client's one door to `backend/src/wire/`: its wire types are type-only re-exports of the
server's, so a field renamed on the server is a `tsc` error in `web/`, not an `undefined` on a
screen. The one exception is the list of saved charts, which `web/src/api.ts` parses itself.

## One person, one folder

Everything the app keeps is under `QUIETPURSE_HOME`, `~/Quietpurse` by default:

```
~/Quietpurse/db/                        the PGlite data directory
~/Quietpurse/statements/                <stem>_<import id>.<csv|xlsx|pdf>, the uploaded bytes, plain
~/Quietpurse/quietpurse.lock            the running process's pid
~/Quietpurse/quietpurse.lock.takeover/  left only by a start that died mid-takeover; safe to delete when no Quietpurse is starting
```

`DOCUMENT_STORE_PATH` can move the statements, and `DATABASE_URL` replaces PGlite with a PostgreSQL
server.

There is no sign-in and no tenant. Whoever reaches the port owns the data, so the server binds the
loopback interface unless told otherwise, and no query carries an owner: every table is the person's.

PGlite does not refuse a second process on its directory, and two writers corrupt it silently. The
lock file prevents that. It is taken before the database opens, refused while a live pid holds it,
and removed on a normal exit. A lock left by a crash holds a dead pid, and the next start takes it
over. With `DATABASE_URL`, the server does its own locking and the file is not written.

`SECURITY.md` says what this shape protects and what it does not. The rules for transaction identity,
import provenance and migrations are in `AGENTS.md` under *Invariants*.

## Adding a statement format

1. Write the parser in `backend/src/providers/`. It returns a `Sheet`, and `readSheet` in
   `backend/src/providers/statement.ts` gets a `case` for it.
2. Add the type to `IMPORT_SOURCE_TYPES` in `backend/src/wire/index.ts`, and teach `sniff()` to
   recognise it **from the bytes**: by evidence that the format is there, never by the absence of
   others. CSV is the one exception, the fallback when nothing else matches and the file starts with
   no NUL byte.
3. Add it to `PARSER_VERSION`, `SIZE_CAP` and `FORMAT_NAME` in `backend/src/providers/statement.ts`,
   and to the file dialog's list in `web/src/components/CsvImport.tsx`. `FORMAT_NAME` feeds the
   refusal that lists the accepted formats, and a format the person is not told about is one they
   cannot be clearly refused for. The type's name is also a stored statement's extension.
4. Add fixtures. PDF fixtures are built in code (`backend/test/pdffixture.ts`), because `.gitignore`
   refuses every statement format.

## Testing

How the suites run and what they cannot see is in `AGENTS.md` under *Verification has a hole*.
