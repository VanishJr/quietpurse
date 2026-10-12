---
id: submodule-backend-db
type: submodule-design
status: draft
title: The schema, every query, and the one function that opens the database
parent: module-backend
---

## Responsibility

- **The schema and its migrations.** A person runs `drizzle-kit generate` to turn
  `backend/src/db/schema.ts` into migrations. Opening the database applies them, so there is no
  separate migrate step.
- **The engine.** `openDatabase` opens the embedded PGlite in the configured folder, or a PostgreSQL
  server when a connection string is set. The embedded engine is Postgres in a process, not a file
  database, because the raw `sql` here uses casts and clauses SQLite refuses.
- **Every finance query.** The database holds one person's data, so no query names an owner.
- **The deduplication key format**, in `backend/src/db/dedup.ts`. Nothing in `backend/src` outside
  this directory builds or parses a key. The helpers that split and rebuild one live beside the
  format, not beside the renumbering query, so the format reads in one file: a key written one way
  and read another makes a re-import duplicate the person's whole history.
  `backend/test/imports.test.ts` pins the format with literal keys.
- **`ERROR_DETAIL_MAX`**, declared in `backend/src/wire` and re-exported here.

## Boundary

**Nothing in `backend/src` outside this directory imports the ORM, but nothing enforces that.** The
handle is exported on purpose: the tests read columns back through it. This module owns the finance
data and opening and closing the database. What a caller writes through the handle is the caller's.

**Driver differences stop here.** Some aggregates arrive as text, and which ones depends on the
driver, so a query without the conversion passes on one driver and fails on the other. `backend/test/SPEC.md`,
under *Invariants*, says which CI job catches it. Each conversion sits on the line that reads the
column, because dropping it is an edit to that line. The same goes for alias case and money
rounding.

**`ResolvedAccountId` is an account id proven to be a row here, and the brand stops at this
module.** It cannot be made without an explicit assertion, so a second way of turning a request into
an account id is a compile error. Two callers that derive an id differently, say from a name, put a
statement's rows in an account its own summary does not name. A producer brands only an id it has
just read from a row. The brand is phantom and never crosses the wire.

## What a caller owes this module

**Only an open handle.** The process entry opens and closes the database; the suite opens its own,
embedded or real, and truncates it between files. A query before that throws. There is no owner, scope or
request context to pass, so do not thread one back into the signatures.

**Inside a transaction, every statement uses the transaction's handle.** PGlite has one connection
behind a mutex: a statement on the outer handle inside a transaction callback waits forever for a
lock the callback holds. On PostgreSQL the outer handle is a second connection with its own
snapshot, so the same rule keeps the confirm step atomic. The suite would hang on a violation rather
than report it.

**A long transaction freezes the app, so writes over many rows are batched.** With one connection,
nothing else is answered while a transaction is open. A write over a set is one statement per batch,
sized against the driver's parameter limit. It runs outside one long transaction wherever the app
can recover from a partial result. Neither suite sees a freeze: both run sequentially, and the
node-postgres pool has more than one connection.

**What a re-tag that dies half way leaves behind.** The re-tag (`applyClassification`) can run
outside one transaction because a run records, only after it finishes, the signature of the rules it
loaded and the owed mark it loaded, as paid. A run that dies half way records neither, so the next
start recomputes if the owed mark is unpaid or the rules sign differently. Nothing else is compared,
so these leave tags the next start does not see: a run whose load found both settled, a rule change
undone mid-run, and a rule change the signature misses. It misses lists of owner names or income
patterns that sign alike, and category rules sign as a set while the matcher takes the newest match.

**A write to rows or columns the classifier reads marks a recompute owed, in its own
transaction.** The mark is a fresh value in `meta`, so it commits or rolls back with the rows. The
door's recompute pays it; a start that finds it unpaid recomputes. It lives in the data function,
not the route, so no caller can skip it. A new function that forgets it fails silently, and only
review catches that. Writes the classifier never reads do not mark (a manual transfer mark, a base
amount, a deduplication key). Rule writes do not mark either: the signature carries a change it
sees, and a change it misses leaves nothing owed. A category override marks, and its route
recomputes, only when it enters or leaves Support, the one thing the classifier reads from a manual
category.

## What the schema's shape commits a future producer to

**Every table follows the same conventions.** Money is integer minor units, so `SUM` is exact.
Dates and timestamps are ISO-8601 text, so they compare as strings and group by month with a
substring. An exchange rate is a ratio, not money, so it is double precision. Flags are booleans. A
new table that breaks these sums and groups differently from the rest.

**Each table is keyed by what identifies a row to the app, and nothing else**, so a query that names
an id names one row.

**Account names are unique, case-folded**, because the account picker on the import screen could not
tell two same-named accounts apart either. Creating and renaming are where names collide.

## Import provenance, and what an import's row promises

**An import row is one uploaded file and the provenance of everything it produced.** Deleting it
deletes exactly the transactions that import first wrote: no other import's, and no row without an
import. Any code that deletes a person's transactions, directly or through their import rows, must
stay as visible as `deleteImport`, the account delete and the restore, never buried in a helper.

**`import_id` names the first writer only.** A later import of a file with the same row inserts
nothing and is recorded nowhere. Deleting the first import removes the row although the later file
still has it. That is the accepted reading of provenance.

**A re-import inserts nothing because an incoming batch numbers its ordinals from one.** A row with
no provider reference has a key ending in an ordinal, dense from one within its group. Rows whose
ordinal is already stored collide on the deduplication index and are skipped, so only a genuinely
larger batch inserts anything. The database makes that comparison; nothing counts what is stored
first. Continuing from the stored
maximum, the fix a reader meeting the density rule will reach for, makes every re-import duplicate
the statement, and stays green in every test that imports a file once.

**The import row records its account, because the confirm request does not carry the form
fields.** The account is resolved when the rows are staged and read back unchanged at confirm, which
derives nothing. The import history prints what the row says, not the account's current name.

**Only a committed import claims its file hash.** That is one layer of a duplicate defence whose
layers are independent on purpose; treating one as the whole defence is how a hole gets declared
closed. Why the index is partial is written on it, in `backend/src/db/schema.ts`.

**A staged row has no deduplication key, and lives in its own table.** The key is computed and
arbitrated at confirm, so a staged row claims no slot. An import uploaded while another awaits
confirmation inserts every row it should, and discarding the other cannot take away a row this one
was told already existed. A separate table, not a status column, keeps unconfirmed rows out of every
read path with no filter to forget.

## What each import status promises

The server owns this vocabulary; the client mirrors it.

- **`pending`**: written, outcome unknown. In practice the process died mid-import.
- **`awaiting_confirmation`**: parsed and staged, waiting for the user. A separate value because a
  pending row is a corpse, and offering it for confirmation would offer a half-written import.
- **`committed`**: its rows are in the database.
- **`discarded`**: the user or the server said no. The row stays because it references the stored
  statement, which a person who rejected the numbers will ask for. It owns no transactions and claims
  no file hash, so the file can be uploaded again. An empty error detail means the user declined; a
  sentence means the server did (a newer upload of the same file superseded it, or a restore brought
  it back unconfirmable). A new producer of this status must write a sentence. Otherwise the person
  is told they rejected an import they never saw, and a displaced copy looks like a refused one.
- **`failed`**: storing, reading or staging the file threw. It owns no transactions: rows reach
  `transactions` only at confirm, in one transaction, and its staged rows are deleted. It keeps its
  stored document, if one was stored.

## The stored source document, and what its pointer does not mean

**The pointer says a document can be read for this row, not where it is.** `backend/src/documents.ts`
derives the file name from the row on every use, because a stored name is a string a restored backup
could choose. So the id, the uploaded filename and the recognised format are written once and never
updated, and a function that deletes a file must get all of them before the row is gone.

**The format has a CHECK because it ends the file name.** A format with a dot would let one row's
fields name another row's file. No request carries a format, since the server reads it
from the bytes, but every writer meets the CHECK on `imports.source_type`, and the restore refuses a
bad value even earlier. A database created before the CHECK joined the initial migration lacks it;
the refusal in `backend/src/documents.ts` holds on every database.

**A cleared pointer does not mean there is no file.** A process that died after storing the file and
before setting the column leaves both. Nothing that deletes may read a cleared pointer as "no file":
the delete path removes the file without consulting it.

**A set pointer does not mean the file exists.** The pointer travels in a backup, so a restored row
claims a file on the machine of the upload, which is right for a person restoring their own backup
there. Elsewhere the read refuses the claim, by its own error class and by the hash check.

**So a restore keeps the pointer.** The backup carries everything the name is derived from. Stripping
the pointer would make every restored import read as having no document while its statement sits in
the folder.

## What a backup carries, and what a restore may never keep

**A backup is one JSON file with every table except the local ones.** A table is local when its rows
are not the person's data to move; staged rows are an upload nobody confirmed. Each local table
carries its reason, and a dump that names one restores nothing into it. Statements are not in the
backup: they are files the person can copy.

**A restore replaces each table the dump provides, in one transaction**, ignores tables this schema
does not know and keeps those the dump omits. A dump with imports must carry transactions, since
deleting imports cascades into them. Goal tables are always cleared together: a version-one dump's
legacy goal data replaces saved goals, and a version-two dump must carry every goal table.
Version-one goal settings, baseline lines and budgets go through a standalone conversion, which
cannot keep goals that existed before the restore. Statements of deleted import rows stay on disk,
removable through the app if their import comes back and only through the folder otherwise. That is
accepted, not a bug.

**A restore always leaves a recompute owed**, written after its table loop as a fresh value, never
the one the dump carries: a run in flight may have loaded that same value and would then pay for
rows it never read. The mark is never added to the dump's rows: that would change what the restore
reports, and a dump without `meta` would then clear the current signature.

**An import awaiting confirmation never survives a restore.** The backup carries no staged rows, so
its Confirm would insert nothing and report success. The restore turns it into `discarded` with a
sentence. The status is matched by type, not by a string, so renaming it is a compile error rather
than a silent miss.

**A restore file writes straight into the database, so every row is checked before anything is
deleted.** A row must be an object, and is cut down to its table's columns, with values they accept.
Otherwise a wrong type becomes a driver error mid-transaction, reported as a server failure instead
of a bad file, and a JSON object in a text column shows up wherever it is displayed. Unknown tables
and columns are dropped, so a backup from a newer release, in a format version this one reads,
restores what this one understands. A value outside a column's vocabulary refuses the whole file, a
newer release's too: an income source of an unknown kind would count as own earnings (only
`external` is subtracted) and silently move the self-sufficiency figure. A refusal of a row names
the table and the column, never the value; a refusal from the database names neither.

**A planted "no rate" answer in `meta` does no more harm than a planted rate.** A crafted backup can
keep a key's rows unconverted, and counted, until that answer goes stale (a future timestamp counts
as stale), or make them convert at an earlier probe day's rate.

**Tables with a generated id get new ids on restore**, since another machine's ids may be taken here
and nothing references them across tables.

## The vocabularies the client composes against

**Chart vocabularies are declared in `backend/src/wire`; this module uses the tuples for column
options and CHECKs.** The database applies the CHECK in the migration, so a member added without
`npm run db:generate` widens the door but not the column. `backend/test/db.test.ts` catches it.

**The CHECKs exist because the client re-saves a list it cannot fully read.** `parseChart` in
`web/src/analytics.ts` refuses an unknown kind, `chartEntry` keeps the row as unreadable, and
`entryWire` sends it back unchanged. A bad value that arrived through a restore would come back on
every read and be refused on every save, taking the whole list with it. Length bounds have no CHECK:
an over-long title is still readable, and `normaliseForSave` cuts it and says so.

## Invariants

`AGENTS.md`'s *Invariants* carry transaction identity, import provenance and the migration rule; they
are not repeated here.

**Support is a derived, read-only external income source.** The transaction mapper and the SQL
summaries choose it the same way, manual category before automatic. Stored source overrides survive
Support being removed. It does not depend on editable sources, so repurposing the seeded Support
source cannot turn Support into own earnings. Its label is the client's: the summary returns its id
as the label.

**Transfer rules store their matching mode.** An old database or backup defaults to exact matching;
widening it needs the previewed group action.

**Every schema table is either carried by a backup or local, decided once.** Backed-up tables are
keys of `BACKUP_TABLES` in `backend/src/db/index.ts`, under their SQL names; local ones are keys of
`LOCAL_TABLES`, valued by their reason. Tables are picked from the schema's exports by shape, so
another kind of export neither breaks the decision nor slips past it. `npm run typecheck` fails on a
table decided neither way or both, and on a backup key that differs from its table's declared name.
The check sits on `LOCAL_TABLES`, a value a test reads, because a type nothing references gets
deleted in a tidy-up with the typecheck still green. What types cannot see,
`backend/test/backup.test.ts` holds, each case with its reason. Its list of exported table names is
a literal because moving a table to local drops it from every backup while export and restore still
succeed, so that move has to edit a test. A backed-up table never references a local one: its export
would succeed and its restore would fail on every other machine.
`GOAL_BACKUP_TABLES` and `IDENTITY_TABLES` are still kept by hand. Their members are typed as backup
names, but a new table that belongs in one is caught in review or not at all.

**The tables an account delete reaches are derived from the schema.** Every table with an account id
must have an entry in `ACCOUNT_CASCADE`, so a new one is a compile error until someone decides what
deleting an account does to it, instead of rows left behind silently. The type proves an entry
exists, not that it runs, so `backend/test/accounts.test.ts` writes the names out as a literal.
Charts, goal-account links and debt-goal configuration outlive the account on purpose. No table has a foreign key to accounts, so
no constraint stops a delete path that removes these rows or points them at another account.

**`settings` holds what a person edits, `meta` what the app keeps about itself, by convention
only.** `meta` holds stamps compared on the next start or write, such as a provider's "no rate"
answer under a key naming the provider and the question, read and written by that key alone. Goal configuration lives in the goal
tables. The legacy `meta.settings` key is read only by the version-one restore conversion, then
removed.

**A Financial independence goal owns its baseline lines.** Their ids and labels are scoped to the
goal, and deleting the goal deletes them. Replacing the goal's configuration and costs is one
transaction, so an invalid amount can refuse the change but is never read as a deletion.

**Goal capacity is held by the write, not by a route preflight.** A create counts and inserts in one
transaction, so concurrent requests cannot both take the last free slot.
