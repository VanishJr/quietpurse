# backend/src/db

Status: draft

What this module is for, where it stops, and the rules about it that no type and no test holds.
Everything already enforced beside the code it governs stays there: `AGENTS.md`'s *Invariants*
carry workspace scoping, transaction identity, import provenance and the migration-squash rule, and
nothing below repeats them. The reasoning behind the constraints the schema and the workspace
context declare used to sit in the headers of those files; it is here now. What stayed beside the
code is what an edit to its own line would break.

## What this module owns

- **The schema, and through it the migrations.** `drizzle-kit generate` diffs
  `backend/src/db/schema.ts` into the migration directory; this module applies what is there when
  the server connects. Generation is a command a person runs, application is not.
- **Every finance query the app makes**, each scoped to the workspace carried in
  `backend/src/db/workspace.ts` rather than passed as an argument.
- **The deduplication key format** (`backend/src/db/dedup.ts`), which is a shared format rather than
  a private one: a script outside this module reconstructs the same keys. If the two ever
  disagreed, the first re-import after a migration would duplicate a user's whole history. The
  helpers that take a key apart and put it back together live with the format rather than beside
  the query that renumbers with them, so the format stays readable in one file.
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

**The driver's types are absorbed here, so no caller sees a string where a number belongs.**
PostgreSQL hands an aggregate over as text, and which aggregate does so depends on the driver, so
a query written without the conversion is green against one and red against the other. The
difference between the two drivers, which of them the suite runs on and which CI job reds, is
written once, in `backend/test/SPEC.md` under *The invariants no type and no test holds*; it is not
restated here. The conversions themselves sit on the lines that read the columns, because the edit
that drops one is an edit to that line — and the same is true of the two other things the SQL
dialect makes a caller's problem rather than a type's: an alias whose case must survive, and money
rounding, whose convention is written whole where the rounding happens.

**An account id proved to be a row of this workspace is a type, and that type stops here.** It
cannot be produced without writing the assertion that says so, so a second way of turning a
request into an account id is a compile error rather than a review finding — a name was an id
once, through
a slug function, and two callers deriving it differently put a statement's rows in an account its
own summary did not name. Each producer brands an id it has just read out of this workspace's own
rows, never a string that arrived off the wire unread. The brand is phantom and nothing that
crosses the wire carries it: the client mirrors plain objects, so the account id on an import
record, an import summary and an account stays a plain string.

## What a caller owes this module

**The workspace is context, not a parameter, and that was a decision rather than an omission.** The
data layer is called from modules that make no workspace decision of their own — the workspace is
fixed once, at the boundary. Threading a workspace id through every signature would touch every
caller for no information gain, and the alternative a reader will re-attempt is exactly that
threading, so it is written down here rather than argued again.

What a caller owes, therefore:

- **An HTTP request** is wrapped for the whole handler chain, with the workspace resolved from the
  session's membership.
- **Background work** picks a workspace and wraps its own run — one workspace, or each of them in
  turn. Nothing schedules that work; a caller starts it and owns the wrapping.
- **Tests and one-off scripts** may set a process-wide fallback instead, and setting one is refused
  when the server is running as production. The refusal is what keeps a fallback left standing on a
  real server from turning the loud "no workspace context" throw into a silent query against
  somebody else's data. It reads the environment the container image sets, so a deployment that
  does not go through that image has to set it itself or the guard is inert — the same condition
  `backend/src/config.ts` states for its own production defaults, in its own words, because each is
  broken by an edit to its own line.

## What the schema's shape commits a future producer to

**The conventions are the SQLite era's and they were kept deliberately.** Money is an integer count
of minor units, so a `SUM` stays exact and no reader has to know about a float. Dates and
timestamps in the finance tables are ISO-8601 text, which compares lexicographically and groups by
month with a substring rather than date-type gymnastics. An exchange rate is a ratio and not money,
so it is double precision. What did change on the way over is that integer flags became real
booleans. Anything added to `backend/src/db/schema.ts` follows those, and a table that does not is
a table whose sums and month grouping work differently from every other.

**The auth tables are the exception, and they are the plugin's rather than the app's.** They carry
real timestamps because better-auth's adapter reads and writes `Date` objects. An *organization* in
those tables **is** a workspace: the app says workspace everywhere and the table keeps the plugin's
name, so a reader meeting `organization` has not found a second concept. Neither has a reader
meeting `auth_account`, which is a credential or an OAuth account and never one of the user's bank
accounts.

**Every finance table starts with the workspace, and deleting a workspace cascades into its data.**
Account ids are provider-derived and unique only within a workspace — two people connecting the
same bank produce the same id — so those tables are keyed on the workspace and the id together.
Transactions keep the composite key too, even though their own id is a UUID: nothing in the schema
is keyed by an id alone, so a query that forgets the workspace filter cannot compile a path to
somebody else's row.

**An account's name identifies it to a person, so no two of them may share one.** Two accounts a
person cannot tell apart are two the account picker on the import screen cannot tell apart either.
The doors that collide there are creating an account and renaming one.

## Import provenance, and what an import's row promises

**An import row is one uploaded file and the provenance of everything it produced.** Deleting it
takes its transactions with it, which is the whole point of the row; `deleteImport` is the only
sanctioned path to that deletion, and anything that ever needs to delete a user's transactions must
be as visible as it is rather than buried in a helper. What it removes is exactly the rows that
import first wrote — not another import's, not another workspace's, and not a row no import owns.

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
comparison** — nothing here counts what is stored first. Continuing from the stored maximum instead, which is the repair a reader who meets the
density invariant will reach for, makes every re-import of one file duplicate the user's statement,
and it stays green in every test that imports a file once.

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

The column on an import row records two things and deliberately not a third: that a document can be
read for this row, and which key layout its bytes were written under. **Not the key itself** — the
key is derived at read time from the current workspace and the import id, because a key read out of
a row is a string a restored backup gets to choose.

**An empty pointer means no document can be READ. It does not mean there are no bytes on disk.**
An import from before the layout was recorded, a row restored from a backup, or one that died
between the blob landing and the column being set all have nothing there and may well have a
document. Nothing that deletes may treat the empty pointer as "no document" — the delete path
addresses a document without consulting it, which is what keeps those files removable.

## What a backup carries, and what a restore may never keep

**"My data is mine" is one button.** A backup is a JSON dump of the current workspace's rows in
every user table; the workspace id itself is stripped on export and reassigned on restore, so a
backup moves between workspaces and between servers freely. Auth tables are deliberately not
included: users and sessions belong to the server, not to the workspace's data.

**A restore clears the current workspace's tables and loads the dump in one transaction**, skipping
tables the current schema does not know, so a future version's backup restores what this version
understands. Two things it leaves behind are accepted rather than unnoticed: the source documents
of the import rows it deletes stay on disk, and of those, the ones whose import id comes back in
the file are still removable through the delete path while the ones whose row is not reinstated are
referenced by nothing and no sweeper exists. Both are data-subject-deletion lines rather than bugs
to fix in the restore.

**Some columns and some statuses may never survive a restore, and both sets are typed rather than
listed as strings.** A renamed property or a renamed status value is then a compile error instead of
a set that quietly stops matching — the failure this guards against is silent in both directions.
The document pointer is one of them, because it is a claim about bytes on *this* server's disk and
the backup carries none: a restored row that kept it would promise a file that is not there or,
from a crafted backup naming another workspace's import ids, somebody else's. The
awaiting-confirmation status is another, because it is a claim about staged rows and the backup
carries none of those either — it would arrive as an import whose Confirm inserts nothing and
reports success.

**A restore file is otherwise a direct write path into the database**, so the rows are filtered down
to real columns of the target table holding values the column accepts. Without that, a string where
an integer lives becomes a driver error mid-transaction, which reaches the user as a server failure
where they should have been told the file was bad — and a JSON object smuggled into a text column
reappears everywhere that value is displayed. Anything unrecognised is dropped rather than
rejected, which is what lets a backup from a future version restore what this version understands.

**Tables with a generated identity id have their ids dropped and regenerated on restore.** A backup
may come from another workspace or server whose ids are already taken here, because identity
sequences are per table rather than per workspace. Nothing references those ids across tables, so
renumbering costs nothing.

## The vocabularies the client composes against

**The chart vocabularies are written in the schema module**, and the door and the database both
derive from them rather than restating them: the route's schema and the check constraints are built
from those arrays. But the constraint the database actually applies is the one in the generated
migration, so a member added without regenerating widens the door and leaves the column where it
was.

They are in the database and not only at the door because **the client substitutes rather than
refuses**: `web/src/analytics.ts` falls back to the first kind, so a restored value it does not know
would draw as a different chart under the reader's own title. Length bounds get no constraint,
because an over-long title substitutes nothing.

**The chart id's charset is one the client composes against and cannot import**, since the two
packages share no build. It sits with the other bounds on a chart, which is where
`backend/test/charts-door.test.ts` looks for the things that cross that boundary. A narrowing here
that the client does not follow means the client keeps sending an id the route now refuses — and
the route refuses the whole list over it.

## The invariants no type and no test holds

**Adding a workspace-scoped table means editing lists by hand, and nothing connects any of them to
`backend/src/db/schema.ts`.** They are `BACKUP_TABLES` in `backend/src/db/index.ts`, which decides
what a backup contains; the table set exercised by `backend/test/tenant-isolation.test.ts`, whose
header states that it is kept equal to the first by reading; the enumeration in
`backend/test/workspace-scope.test.ts`, which its own comment admits is hand-written; and `TABLES`
in `backend/test/pglite.ts`, the truncate list. Nothing holds that list of lists either, so another
may exist and be named nowhere. Missing one is silent in the direction that matters: the export
succeeds, the restore succeeds, and what the reader built is in neither.

**The tables a deleted account leaves rows in are derived from the schema rather than remembered.**
Every exported table carrying both an account and a workspace is one of them, and both conditions
are load-bearing: the auth account table has an account id and a user id and no workspace, and it
is better-auth's rather than an account of the user's. No foreign key runs from any of those tables
to `accounts`, so nothing in the database would catch a table this derivation missed. Not every
table a deleted account touches loses its rows, and which of them outlive the account is stated
beside each of them rather than here.

**`settings` and `meta` are the same shape, and which one a value belongs in is a convention with
no enforcement.** `settings` holds what a person edits about their workspace, such as
`base_currency` and `owner_names`. `meta` holds what the server keeps about itself, a stamp it
compares against on the next start or the next write. The exception is the one a reader adding a
value will get wrong: the Goal screen's configuration is a person's, and it lives in `meta` as one
JSON blob under the key `settings`. A new setting written to the table of that name is not where
the existing ones are.
