# backend/src/db

Status: draft

What this module is for, where it stops, and the rules about it that no type and no test holds.
Everything already enforced beside the code it governs stays there: `AGENTS.md`'s *Invariants*
carry transaction identity, import provenance and the migration-squash rule, and nothing below
repeats them. The reasoning behind the constraints the schema declares used to sit in the headers of
those files; it is here now. What stayed beside the code is what an edit to its own line would break.

## What this module owns

- **The schema, and through it the migrations.** `drizzle-kit generate` diffs
  `backend/src/db/schema.ts` into the migration directory; this module applies what is there when
  the database is opened. Generation is a command a person runs, application is not.
- **Which engine the database runs on.** One function opens it: the embedded PGlite in the folder
  the configuration names, or a PostgreSQL server when a connection string is set. The two are the
  same dialect — every raw `sql` template here carries casts and clauses SQLite would refuse, and
  that is why the engine that replaced the server is Postgres in a process and not a file
  database. Opening is also migrating: that function applies the migration directory before it
  hands the handle back, so there is no separate migrate step and no script for one. Everything
  in `backend/src` that needs a handle goes through it, so the choice is made in one place. The
  suite is the one opener that does not: `backend/test/pglite.ts` opens its own — in memory, or on
  the server its own variable names — and migrates it from the same directory.
- **Every finance query the app makes.** There is one person's data and nothing else in the
  database, so a query names no owner: the whole table is theirs.
- **The deduplication key format** (`backend/src/db/dedup.ts`). It is this module's alone now: its
  one outside reader, the script that carried a SQLite database over and rebuilt the same keys,
  went with the SQLite era, and nothing in `backend/src` outside this directory composes or parses
  a key. What pins the format is `backend/test/imports.test.ts`, which writes the keys it expects
  out as literals. The helpers that take a key apart and put it back together still live with the
  format rather than beside the query that renumbers with them, so the format stays readable in
  one file — a key written one way and read another is a re-import that duplicates a person's
  whole history.
- **The diagnostic budget** for a failed import, `ERROR_DETAIL_MAX`, declared in `backend/src/wire`
  and re-exported through this module. What holds the client's cap to it is the client's own `tsc`:
  `MAX_ERROR_CHARS` in `web/src/api.ts` is written `satisfies typeof ERROR_DETAIL_MAX` over a
  type-only import of the wire, so the two cannot differ.

## Where the boundary runs

Nothing in `backend/src` outside this directory imports the ORM. That is the boundary as measured,
and **nothing enforces it** — no check refuses the next file that imports it, so the sentence is
true today and holds nothing about tomorrow.

The crossing below exists and it is deliberate. Nothing holds that either:

- **The handle is exported.** A query written through it is a query outside this module, and the
  tests use it to read a column back that no function answers.

So the honest statement of ownership is: this module owns the finance data, and it owns opening
and closing the database. What a caller writes through the exported handle is outside that.

**The driver's types are absorbed here, so no caller sees a string where a number belongs.**
PostgreSQL hands an aggregate over as text, and which aggregate does so depends on the driver, so
a query written without the conversion is green against one and red against the other. The
difference between the two drivers, which of them the suite runs on and which CI job reds, is
written once, in `backend/test/SPEC.md` under *The invariants no type and no test holds*; it is not
restated here. The conversions themselves sit on the lines that read the columns, because the edit
that drops one is an edit to that line — and the same is true of the two other things the SQL
dialect makes a caller's problem rather than a type's: an alias whose case must survive, and money
rounding, whose convention is written whole where the rounding happens.

**An account id proved to be a row of this database is a type, and that type stops here.** It
cannot be produced without writing the assertion that says so, so a second way of turning a
request into an account id is a compile error rather than a review finding — a name was an id
once, through a slug function, and two callers deriving it differently put a statement's rows in an
account its own summary did not name. Each producer brands an id it has just read out of a row,
never a string that arrived off the wire unread. The brand is phantom and nothing that crosses the
wire carries it: the client mirrors plain objects, so the account id on an import record, an import
summary and an account stays a plain string.

## What a caller owes this module

**Nothing but the handle being open.** The process entry opens the database before anything reads
it and closes it on the way out; the suite opens one in memory once per run and truncates it
between files. A function called before either has happened throws, which is the only ambient
state left — there is no scope to carry, no fallback to arm and no context a request has to enter.
That absence is the whole of what deleting the tenancy bought, and it is stated so nobody threads a
parameter back through every signature for information no caller has.

**The embedded engine is one connection, and this module's transactions are written for that.**
PGlite holds one connection and serialises everything behind a mutex, so a statement issued on the
outer handle from inside a transaction callback waits for a lock the callback holds and never
returns. Every function that opens a transaction therefore issues every statement of it on the
transaction's own handle — which is also what makes the confirm step atomic on a real Postgres,
where the outer handle is a second pooled connection and a second snapshot. The suite runs on the
same engine the product does and would hang on the first violation rather than report one.

**The same one connection makes a long transaction a freeze, and that is a rule about writes over
many rows.** A pool serialises nothing: one connection holds the transaction and every other query
in the application goes down another. PGlite has no other, so for as long as a transaction is open
this module answers nothing at all — a re-tag that issued one statement per row inside one
transaction stopped the whole app until it finished. So a write over a set is one statement over
that set, in bounded batches sized against the driver's parameter ceiling, and it is outside a
single long transaction wherever a partial result is one the app converges out of rather than one
it can be stuck in. The re-tag qualifies because its version stamp is written after it returns: a
run that dies half way leaves the old stamp and the next start recomputes everything. **Neither
suite can see this.** They run sequentially, so nothing is ever waiting behind the transaction, and
the driver that CI's second job uses does not have the property at all.

## What the schema's shape commits a future producer to

**The conventions are the SQLite era's and they were kept deliberately.** Money is an integer count
of minor units, so a `SUM` stays exact and no reader has to know about a float. Dates and
timestamps are ISO-8601 text, which compares lexicographically and groups by month with a substring
rather than date-type gymnastics. An exchange rate is a ratio and not money, so it is double
precision. What did change on the way over is that integer flags became real booleans. Anything
added to `backend/src/db/schema.ts` follows those, and a table that does not is a table whose sums
and month grouping work differently from every other.

**Every table is keyed by what identifies a row to the app, and nothing else.** An account, an
import, a transaction, an income source and a chart are each keyed by their own id; a rate by its
day and currency; a staged row by its import and its position in the file; a setting by its key.
There was a second column in every key once, which let two people hold the same id, and it went
with the second person. A query that names an id names one row.

**An account's name identifies it to a person, so no two of them may share one.** Two accounts a
person cannot tell apart are two the account picker on the import screen cannot tell apart either.
The doors that collide there are creating an account and renaming one.

## Import provenance, and what an import's row promises

**An import row is one uploaded file and the provenance of everything it produced.** Deleting it
takes its transactions with it, which is the whole point of the row; `deleteImport` is the only
sanctioned path to that deletion, and anything that ever needs to delete a user's transactions must
be as visible as it is rather than buried in a helper. What it removes is exactly the rows that
import first wrote — not another import's, and not a row no import owns.

**`import_id` names the first writer and not every attestation.** A later import whose file
contains the same row inserts nothing and is recorded nowhere, so deleting the first import removes
the row even though the later one still asserts it. That is the accepted reading of provenance, not
an oversight in it.

**Re-importing a file the user has already imported inserts nothing, and what makes that true is
where an incoming batch's ordinals start.** A row a provider gives no reference of its own is told
apart by a key ending in an ordinal, dense from one within its group; an incoming batch numbers its
own rows from one again rather than continuing from the highest ordinal the group already holds.
The rows whose ordinal is already taken therefore collide on the deduplication index and are
skipped, so only a genuinely larger batch inserts anything at all. **The database performs that
comparison** — nothing here counts what is stored first. Continuing from the stored maximum instead,
which is the repair a reader who meets the density invariant will reach for, makes every re-import
of one file duplicate the user's statement, and it stays green in every test that imports a file
once.

**The account an upload went to is recorded on the row because the confirm step does not carry the
form fields.** The account is resolved once, when the rows are staged, and read back verbatim at
confirm, which derives nothing — that is what holds the two requests together now that a name is
not an id. The account's name as it read at upload time stays that fact forever: a later rename
moves the account and never the import row, and the import history prints what the row says.

**Only a committed import claims a file hash, and that is one layer of the duplicate defence rather
than the whole of it.** The layers are deliberately independent, and reading any of them as the
whole defence is how a hole gets declared closed. Why the index that enforces it is partial, and
what narrowing it costs, is written on the index itself in `backend/src/db/schema.ts`, where an
edit to the clause is what breaks it.

**A superseded import is `discarded`, which makes another producer of that status worth a sentence.**
On a discarded row an empty error detail means the user declined the import, so a superseded row
left empty would tell somebody they rejected an import they never saw. It is also the only way a
copy a user displaced can be told apart from one they refused.

**A staged row carries no deduplication key, deliberately.** The key is computed and arbitrated by
the database at confirm time, exactly as it is at import time, so a staged row claims no slot in
the deduplication index: an import uploaded while another is outstanding still inserts every row it
should, and discarding the outstanding one cannot take away a row the other import was told already
existed. Staged rows live in their own table rather than behind a status column on `transactions`
for the same kind of reason — an unconfirmed row is not in the table every read path names, so
there is no filter to forget.

## What each import status promises

This is the vocabulary the client mirrors; the server owns it.

- **`pending`** — the row was written and the outcome is unknown, which in practice means the
  process died mid-import.
- **`awaiting_confirmation`** — parsed, its rows staged, waiting for the user to accept the
  summary. It is its own value rather than an overload of `pending` because a pending row is a
  corpse, and presenting one as "confirm these numbers" would offer a half-written import for
  acceptance.
- **`committed`** — its rows are in the database.
- **`discarded`** — the user looked at the numbers and said no. The row is kept rather than
  deleted, and that is the point: the row is what references the stored source document, which is
  exactly the artefact a user who rejected the numbers will ask for. It owns no transactions, so
  nothing is deleted to reach it, and it claims no file hash, so the file stays re-uploadable. On a
  discarded row the error detail separates the two ways the status can be reached: empty means the
  user declined it, a sentence means the server did.
- **`failed`** — the import did not complete. Usually the parse threw before anything was written,
  but the failure is caught around the inserts too, so whatever rows a failed import did write stay
  attached to it and go with it when it is deleted.

## The stored source document, and what its pointer does not mean

The column on an import row records one thing: that a document can be read for this row. **Not
where it is** — the file's name is derived from the row every time it is needed, in
`backend/src/documents.ts`, from fields that never change once written, because a name read out of
a row is a string a restored backup gets to choose. The rule that follows is this module's: the
three fields a name is derived from — the id, the uploaded filename and the recognised format — are
written once and updated by nothing, and a function that deletes a file has to be handed all three
off the row before the row goes. `deleteImport` reads them ahead of its delete; the account cascade
returns them from its.

**A cleared pointer means no document can be READ. It does not mean there is no file on disk.**
A row that died between the file landing and the column being set has nothing there and may well
have a document. Nothing that deletes may treat the cleared pointer as "no document" — the delete
path addresses a file without consulting it, which is what keeps those files removable.

**And a SET pointer does not mean there is one either.** The pointer travels in a backup like any
other column, so a restored row claims a document whose file belongs to the machine the upload
happened on. That is the right claim to carry: restored onto that same machine, which is what a
person restoring their own backup is doing, the file is there and opens. What answers a claim the
disk cannot honour is the read — a derived key that names no file is refused by a class of its own,
which the download route turns into the same "no file this app can read" a pointerless row gets,
never a fault. The hash check answers the other half: bytes under the key that are not the ones the
row recorded are refused whoever wrote them.

## What a backup carries, and what a restore may never keep

**"My data is mine" is one button.** A backup is a JSON dump of every row in every user table, so
it moves between machines freely. The stored statements are not in it; they are files in a folder
the person can copy on their own.

**A restore clears the tables and loads the dump in one transaction**, skipping tables the current
schema does not know, so a future version's backup restores what this version understands. Two
things it leaves behind are accepted rather than unnoticed: the source documents of the import rows
it deletes stay on disk, and of those, the ones whose import id comes back in the file are still
removable through the delete path while the ones whose row is not reinstated are referenced by
nothing but the folder. Both are lines about a folder the person can open, not bugs to fix in the
restore.

**One status may never survive a restore, and it is typed rather than listed as a string.** A
renamed status value is then a compile error instead of a set that quietly stops matching — the
failure this guards against is silent in both directions. The status is awaiting-confirmation,
because it is a claim about staged rows and a backup carries none of those: it would arrive as an
import whose Confirm inserts nothing and reports success.

**The document pointer used to be stripped here and no longer is.** It was right while the key was
built from a tenant and an id, because a backup loaded elsewhere could not name its own files. The
key is built from the uploaded filename, the id and the format now, and a backup carries all three
— so the pointer is reconstructible, and stripping it threw away something the restore can rebuild.
Stripped, every import on a restored database read as having no document while the statements sat
in the folder untouched.

**A restore file is otherwise a direct write path into the database**, so the rows are filtered down
to real columns of the target table holding values the column accepts. Without that, a string where
an integer lives becomes a driver error mid-transaction, which reaches the user as a server failure
where they should have been told the file was bad — and a JSON object smuggled into a text column
reappears everywhere that value is displayed. Anything unrecognised is dropped rather than
rejected, which is what lets a backup from a future version restore what this version understands.

**Tables with a generated identity id have their ids dropped and regenerated on restore.** A backup
may come from another machine whose ids are already taken here. Nothing references those ids across
tables, so renumbering costs nothing.

## The vocabularies the client composes against

**The chart vocabularies are declared once, in `backend/src/wire`**, and this module imports them
for its column options and its check constraints and never restates them; the door's request schema
composes over the same tuples. But the constraint the database actually applies is the one in the
generated migration, so a member added to the wire's tuple without `npm run db:generate` widens the
door and leaves the column where it was — and `backend/test/db.test.ts`, which inserts every
`CHART_KINDS` member and expects `23514` on a value outside the list, is what reds.

They are in the database and not only at the door because **a list the client cannot fully read is
one it re-saves verbatim, unknown rows included**: `parseChart` in `web/src/analytics.ts` refuses
a row whose kind it does not know, `chartEntry` keeps it as unreadable, `entryWire` sends it back
verbatim, and the screen names it rather than drawing it. A value outside the vocabulary that
reached the table through a restore would therefore come back on every read and be refused by the
door on every save, with the reader's whole list behind it. Length bounds get no constraint,
because an over-long title is a row the client can read: `normaliseForSave` cuts it to the bound on
the way back out and the screen says what was cut.

**The chart id's charset is one the client composes against and cannot import as a value**, since a
value import would bundle this package into the client. It is declared beside the other bounds on a
chart in `backend/src/wire`, as a string source beside the `RegExp` built from it; the `RegExp` is
what this module re-exports, and the client builds its own `RegExp` from a string pinned to the
wire's `CHART_ID_SHAPE_SOURCE` by type. A narrowing there that the client does not follow is
therefore a compile error in `web/` rather than what it would otherwise be — the client keeps
sending an id the route now refuses, and the route refuses the whole list over it.

## The invariants no type and no test holds

**Adding a table means editing lists by hand, and nothing connects any of them to
`backend/src/db/schema.ts`.** They are `BACKUP_TABLES` in `backend/src/db/index.ts`, which decides
what a backup contains, and `TABLES` in `backend/test/pglite.ts`, the truncate list. Nothing holds
that list of lists either, so another may exist and be named nowhere. Missing one is silent in the
direction that matters: the export succeeds, the restore succeeds, and what the reader built is in
neither.

**The tables a deleted account leaves rows in are derived from the schema rather than remembered.**
Every table carrying an account id is one of them. No foreign key runs from any of those tables to
`accounts`, so nothing in the database would catch a table this derivation missed. Not every table a
deleted account touches loses its rows, and which of them outlive the account is stated beside each
of them rather than here.

**`settings` and `meta` are the same shape, and which one a value belongs in is a convention with
no enforcement.** `settings` holds what a person edits, such as `base_currency` and `owner_names`.
`meta` holds what the app keeps about itself, a stamp it compares against on the next start or the
next write. The exception is the one a reader adding a value will get wrong: the Goal screen's
configuration is a person's, and it lives in `meta` as one JSON blob under the key `settings`. A new
setting written to the table of that name is not where the existing ones are.
