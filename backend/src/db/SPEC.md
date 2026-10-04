---
id: submodule-backend-db
type: submodule-design
status: draft
title: db — the schema, every query, and the one function that opens the database
parent: module-backend
---

What this module is for, where it stops, and the rules about it that no type and no test holds.
Everything already enforced beside the code it governs stays there: `AGENTS.md`'s *Invariants*
carry transaction identity, import provenance and the pre-release migration rule, and nothing below
repeats them. The reasoning behind the constraints the schema declares used to sit in the headers of
those files; it is here now. What stayed beside the code is what an edit to its own line would break.

## Responsibility

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

## Boundary

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
written once, in `backend/test/SPEC.md` under *Invariants*; it is not
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
it can be stuck in. The re-tag qualifies because what a run records about itself — the signature
of the rules it loaded, and the debt it loaded, as paid — is written after it returns, so a run
that dies half way records neither, and the next start recomputes everything if the debt it loads
is unpaid or the rules it loads sign differently from the stored signature. That is all it
compares, so a death is repaired only where one of the two still holds then: a run whose load
found both settled, a rule changed unseen, or a rule change undone while the run was in flight can
each leave tags that the next start does not see. The signature does not see every rule change:
different lists of income patterns or of owner names can sign alike, and the category rules sign
as a set while the matcher takes the newest one that matches. **Neither suite can see the
freeze.** They run sequentially, so nothing is ever waiting behind the transaction, and the driver
that CI's second job uses does not have the property at all.

**A function that writes a row or a column the classifier reads marks a recompute owed, on its own
transaction's handle.** The mark is a fresh value in `meta`, written in the transaction that writes
the rows, so a write that commits carries it and a rollback drops both; the door's own recompute
pays it, and a start that finds it unpaid recomputes. It lives in the function and never in a route,
so a new caller cannot leave it out. A new function that writes such rows without it is silent:
nothing holds this rule but this sentence and review. A write the classifier never reads — a manual
transfer mark, a base amount, a deduplication key — does not mark. Neither does a rule write: the
signature carries a rule change it sees, and one it does not see leaves nothing owed. Of a manual
category the classifier reads only whether it is Support, so a category override marks, and its door
recomputes, only when Support is entered or left.

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

**"My data is mine" is one button.** A backup is a JSON dump of every row in every table but the
local ones, so it moves between machines freely. A table is local when its rows are not the
person's data to move: staged rows are an upload nobody has confirmed yet, which is also why an
import awaiting confirmation cannot survive a restore. Each local table carries its reason beside
it, and a dump that names one restores nothing into it. The stored statements are not in it; they
are files in a folder the person can copy on their own.

**A provider's remembered answer that it has no rate travels in `meta` like every other stamp.** A
crafted backup that plants one can hold a key's rows unconverted, and counted, for one age of that
answer at most — a time recorded ahead of the clock counts as stale — or make them convert at an
earlier probe day's rate, and neither is more than a planted rate already gives it.

**A restore clears each table the dump provides and loads it in one transaction**, skipping tables
the current schema does not know and preserving current tables an older or sparse dump omits. A
sparse dump that provides imports must also provide transactions: deleting imports cascades into
their transactions, so accepting only the parent table would erase a table the dump omitted. The
Goal family is the exception: it is cleared as one unit even for a version-one dump, because legacy
Goal settings, baseline lines and budgets replace rather than merge with saved goals. Goal and
subtype tables are loaded in dependency order with the rest. A version-one backup is accepted
through a standalone compatibility conversion of its singleton Goal settings, baseline
lines and budgets; it cannot retain goals that were in the workspace before the restore. Two things it leaves behind are accepted rather than unnoticed: the source
documents of the import rows it deletes stay on disk, and of those, the ones whose import id comes
back in the file are still removable through the delete path while the ones whose row is not
reinstated are referenced by nothing but the folder. Both are lines about a folder the person can
open, not bugs to fix in the restore.

**A restore leaves a recompute owed, whatever the dump says.** It writes the mark after its table
loop, in the same transaction, because a dump that carries `meta` replaces every row of it; and it
writes a fresh value rather than keeping one the dump carries, because a run in flight may have
loaded that same value and would then pay for rows it never read. The mark is never added to the
dump's own rows: that would change what the restore reports, and a sparse dump that omits `meta`
would then clear the current one, signature included.

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

**A restore file is otherwise a direct write path into the database**, so every supplied row must be
an object before legacy conversion, then is filtered down to real columns of the target table
holding values the column accepts. Without that, a string where
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

## Invariants

The effective Support category derives a read-only external income source. Transaction mapping and
SQL summaries must make the same choice, using the manual category before the automatic category.
Stored source overrides remain available when Support is removed. The derived source is independent
of editable income-source names and kinds, so repurposing the seeded Support source cannot turn a
Support category into own earnings. Its label is the client's, like every other category's: the
summary answers the derived source's id as its label and composes no display word.

Transfer rules carry their matching mode explicitly. An old database or backup defaults to exact
matching; widening that mode requires the previewed group action.

**Every table `backend/src/db/schema.ts` exports is decided once: a backup carries it, or it is
local.** A backed-up table is a key of `BACKUP_TABLES` in `backend/src/db/index.ts`, under the name
the backup file gives it, which is its SQL name; a local one is a key of `LOCAL_TABLES` beside it,
valued by its reason. `tsc` holds the decision, and holds it on the local set itself — a value a
test reads — rather than on a type nothing references, which an editor greys out as unused and a
tidy-up deletes with the typecheck still green. The tables are read from the schema's exports by
shape, so another kind of export neither breaks the decision nor slips past it. A table decided
neither way or both ways, or a backup key that is not the name its table's type declares, fails
`npm run typecheck`, and so does a table whose SQL name is typed as a string no literal pins. `tsc`
reads only types, so a table whose type hides it — a name typed `never`, an export typed `object`
or `unknown` — passes the typecheck undecided. A test holds what a type cannot:

- every table the schema exports, read from its values rather than its types, is carried by a
  backup or local, once, under its SQL name — which holds a table its type hides, and a backup key
  that is the name its table's type declares but not its SQL name;
- the insertion order of `BACKUP_TABLES` is the order a restore inserts in, held against the
  foreign keys the migrated database declares, and a table a backup carries never references a
  local one — its export would succeed and its restore fail on every other machine;
- the names an export carries are written out in a test, because moving a table to the local set
  drops it from every backup while export and restore both succeed, so that move has to be an edit
  to a test;
- a dump's rows under a local name are never restored, held over the local set itself.

The truncate list in `backend/test/pglite.ts` is the same schema read at run time, held against
the tables the migrated database has. The backup path still keeps lists by hand that nothing
derives: `GOAL_BACKUP_TABLES`, the family a restore clears as one unit, and `IDENTITY_TABLES`, the
tables whose ids it regenerates. Their members are typed as backup names, so a name that stops
matching is a compile error; a new table that belongs in one is noticed in review or not at all.

**The tables a deleted account leaves rows in are derived from the schema rather than remembered.**
Every account-owned table carrying an account id is one of them. Goal-account links and debt-goal
configuration are the deliberate exception: they have no account foreign key and outlive the row so
the goal can report which saved source became unavailable. No database constraint catches a delete
path that removes them or silently chooses another account.

**`settings` and `meta` are the same shape, and which one a value belongs in is a convention with
no enforcement.** `settings` holds what a person edits, such as `base_currency` and `owner_names`.
`meta` holds what the app keeps about itself, a stamp it compares against on the next start or the
next write — among them a provider's remembered answer that it has no rate, under a key that names
the provider and exactly what it was asked, read and written by that key alone. Goal configuration
belongs to neither: it is normalized into the goal tables. The legacy `meta.settings` key is read
only by version-one restore conversion, then removed.

**A Financial independence goal owns its baseline lines.** Their identity and label uniqueness are
scoped by goal, and deleting the goal cascades them. The write that replaces that goal's
configuration and costs is one transaction; an invalid edited amount can therefore refuse the
replacement but can never be interpreted as deletion.

**Goal capacity is a write invariant, not a route preflight.** A create serializes the count and
insert inside one transaction, so concurrent requests cannot each claim the final available slot.
