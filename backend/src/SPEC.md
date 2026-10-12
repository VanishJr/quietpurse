---
id: module-backend
type: module-design
title: The backend's HTTP door, the process that opens it, and the service modules between them
parent: architecture
---

## Responsibility

This spec covers the code directly in `backend/src`. A subdirectory with its own `SPEC.md` describes
itself, and where a rule here reaches into one, it names the directory and stops. `ARCHITECTURE.md`
says which module owns what. This file holds the rules that tie files
together. A reason that only an edit to its own line would break sits in a comment beside that line
and is not repeated here.

The door owns what crosses it, and nothing behind it.

- **The wire vocabulary.** The door narrows a request with a schema and never casts it: a schema is
  all that stands between a hand-written request and a writer that takes a typed value, and a
  predicate that answers a boolean leaves a string a string. The Goals create and replacement bodies
  live in `backend/src/wire`, because the client composes the same closed type vocabulary. Every
  route's answer is declared there too.
- **Refusal sentences.** A person who is stuck reads them, so each names the way out when there is
  one, and two states with different ways out get different sentences.
- **Transport caps.** `MAX_BODY_BYTES` bounds a body for both the JSON parser and the restore route's
  raw parser, and their refusal sentence is built from it: the content type picks the parser, so two
  literals would mean two ceilings. `UPLOAD_LIMITS` is separate on purpose, because it guards a
  different door with its own sentences, and the two numbers agreeing is not a rule. The caps after a
  decode belong to `backend/src/providers` and are stated only there.
- **The built client.** Below the `/api` routes the door serves `web/dist`, the build
  `web/vite.config.ts` writes, and a page path gets the app's page, so a reloaded `?screen=` URL lands
  where the client routes it.

Parsing a statement, naming a stored file and categorising are not the door's. Each refuses on its
own terms, and the door reports the refusal. The last two live in this directory and are covered
below.

## No session, so the door asks where a request came from

**Every request is the one person's.** With no sign-in, whoever reaches the port owns the data, and
binding loopback is what answers for that. No middleware asks who is calling.

**One middleware asks where a request came from,** because loopback keeps other machines out but not
a page in the owner's own browser. `originCheck` checks `Host` and `Origin` on every `/api` request,
and `Sec-Fetch-Site` on every request that can change state; its docblock says what each header
closes, and `SECURITY.md` says it for readers outside the code. It runs before any body parser, so
a refused request is never parsed.

In normal use nothing crosses an origin: `web/vite.config.ts` proxies the API in development, and the
start command serves the client from the backend. So the check needs no allowlist, no preflight and
no credential.

**A route without a schema reads its JSON body through `jsonBody`,** because a body no parser claims
arrives undefined. It refuses with one sentence, naming the content type the door takes, because with
a zero content length a body-less `fetch` and a body of another type look the same. An empty object
passes, because the parser hands an empty body over as one; whether an empty patch means anything is
the route's call.

## Boundary

**The app is separate from the process that starts it.** `backend/src/app.ts` connects to nothing, and
`backend/src/index.ts` takes the lock, opens the database and listens. That lets the suite drive every
route over real HTTP against an embedded database. So no module `app.ts` imports may reach out to the
world at import time: the app would still import, and the tests would run against a half-booted
process with nothing failing.

**A value is normalised once, at the door that writes it.** An account's currency is upper-cased at
the account doors, and `accountCurrency` in `app.ts` says why. Nothing downstream normalises it
again: `stageImport` in `backend/src/db` copies it onto the import as read, so a restored `eur` is
not rewritten by an import that asked for nothing of the kind. A row's own currency is a different
value, and the parser upper-cases it where it reads it.

**A currency is checked where it enters, against one pattern.** `CURRENCY_CODE` in
`backend/src/currency.ts` is what the account doors, the settings door and the import accept, so a
statement cannot store a currency an account would refuse. A currency cell that does not match
refuses the whole file; the confirm in `backend/src/db` refuses rows an earlier version staged with
one. Both let the account's own currency through unchecked, because a row takes it for an empty cell
and an earlier version may have stored one the pattern refuses. The two exemptions move together: one
without the other stages rows the confirm then refuses, or refuses a file the confirm would take.

**A stored currency is compared in one form.** An earlier version could store `eur`, and it is the
same currency as `EUR`. Every comparison and grouping of a currency read from the database goes
through `currencyKey`, declared in `backend/src/wire/currency.ts` and re-exported by
`backend/src/currency.ts`, or `CURRENCY_KEY` in `backend/src/db`. The two fold ASCII letters only
and agree letter for letter, and `backend/test/currency.test.ts` holds them
to each other and scans for a comparison written past them. Stored rows keep their spelling; answers
send the folded form, as `backend/src/wire/SPEC.md` says, and so does the CSV export. The dedup key
keeps its own `toUpperCase`, because it is stored: a different fold would give an earlier row a
different key than the same row imported again.

**A builtin income source can be edited but not deleted.** That is safe only because
`upsertIncomeSource` in `backend/src/db` never sets `builtin` on conflict. An edit there makes a
renamed builtin deletable.

**A user's filename reaches a header through one builder,** because the key shape in
`backend/src/storage.ts` is not a sanitiser. The download route builds the whole `Content-Disposition`
in one place. The stored file's own name has a separate reduction, under *What is kept of an upload,
and what a crash may leave behind*.

## What a route owes a caller

**4xx is the caller's fault and 5xx the server's,** for the log as much as for the screen. A route
may change the body of a refusal the server caused, never its class.

**The upload does not keep that rule yet.** `POST /api/imports` answers every failure of the import
with 400 and the failure's own message. So a statements folder that cannot be written to, a failed
internal check that every row the importer read was kept or dropped, or a database error reads as
the caller's fault, the last with the failed statement in its text. The restore answers a failed
database write with 400 too, with a sentence of its own. A new route follows the rule, not these
two.

**`errorHandler` follows the `http-errors` contract** of the body-parser and http-errors that the
express in `backend/package.json` brings, so an upgrade can move it silently:

- It passes an error through only with a 4xx `status` and `expose` true, both read by property access,
  because class-based errors keep them on the prototype.
- The router's `URIError` for a path that will not decode has a status and no `expose`, so it stays a
  500 by design.
- A JSON parse failure keeps the parser's words behind the door's prefix: they are the caller's only
  hint of where the stray comma is.
- The 4xx arm logs fields it composes, never the error object: pino copies own properties, and a parse
  failure carries the whole body as one, so the log line would be the size of the body.
- With headers already sent, it logs the cause and passes the error on, because the fallback that
  closes the socket writes to stderr, not to the structured log.

**A wire literal is API.** The summary scopes are `all` and `account`, and the client narrows on them.
Renaming one is safe only while client and server build from one checkout, so no client asking for
the old word can exist.

**A count describes this call, not the preview a client showed.** The account dialog counts a hidden
account's transactions by summing its imports, where a row belongs to the import that first wrote it;
the delete counts what its own statements removed. Confirm's `inserted` is the database's own count,
and the import screen explains when it falls short of the staged summary.

**A refusal for staleness carries the current state.** The chart list is written whole and versioned,
and a stale save is answered with the list as it stands, so the client needs no second request.

## What the process entry owes the app

**One process per folder.** The embedded database accepts a second opener, and two processes on one
data directory overwrite each other's files with nothing failing. So `backend/src/lock.ts` claims a
lock file beside the data, by exclusive create, before anything opens. `backend/test/lock.test.ts`
holds each arm, and `lock.ts` gives the reasons that live on one line. What ties the takeover
together:

- **The file holds only the pid,** and a refused start names that pid in its first words. The `app`
  job in `.github/workflows/ci.yml` reads the file with `kill -0` and greps those words, so neither
  changes without that job.
- **A live pid refuses the start** and names the file as the way out. A dead pid, garbage, or a file
  that stays empty is taken over, so a crash leaves a file and not a locked-out person.
- **A stale file is removed only inside the marker directory `quietpurse.lock.takeover`,** and read
  again under it, so two starts that both find a dead pid cannot remove each other's fresh claim.
- **A start never removes a marker it did not make,** however old. Removing by age is a check and then
  a removal by path, and starts that each take both steps remove each other's markers and are all
  inside at once. So a marker left by a start that died mid-takeover stays until a person deletes it.
- **The second refusal,** *another Quietpurse took it while this one was starting*, names the marker,
  so whoever reads it, or finds the directory, knows what to do. A start prints it when both attempts
  end with no claim and no live holder: a marker nobody releases, or a file that vanishes or holds a
  dead pid again. Losing to a live claim gives the first refusal.
- **The release removes the file only if it holds this pid,** so a refused start, or a shutdown after
  another start took the folder over, leaves the holder's file alone.
- **With a PostgreSQL server, claim and release do nothing:** that server has its own locking.

**Refuse first, listen last.** `backend/src/index.ts` checks the statements folder before it opens the
port; why is beside the check in `backend/src/storage.ts`.

**Seeding runs on every start.** It is the upgrade path for a builtin setting or income source added
in a new version, and no migration can do it, because those rows carry the person's edits. It stays
safe only while `seedDefaults` in `backend/src/db` inserts on conflict do nothing.

**Stopping closes the database and releases the lock,** so the next start does not meet a
live-looking lock. The CI `app` job holds this.

## Invariants

**Nothing is committed on upload.** The upload route stages and answers with a summary, and nothing
moves until confirm. `backend/src/providers` answers a file already committed as a duplicate before
anything parses it. The door can break this promise in one line.

**A stored statement outlives a failed import.** The download is offered at any status, because a
failed import's file is what a person diagnosing it needs; `backend/src/providers` stores the file
before parsing for the same reason.

**Erasure is its own route.** Deleting a document keeps the import row, its transactions and its
provenance, so a person can remove a statement and keep what it imported.

**Reasons are held by nothing.** Behaviour tests hold many rules here,
`backend/test/http-body.test.ts` reads `app.ts` for a bare `req.body`, and the walk at import holds
the answer check's place and the door's named layers. But no test can tell a moved reason from a
dropped one, and a rule broken where no test looks stays green.

## What a figure is denominated in

**Money crosses one narrow boundary.** The database stores integer minor units, so a `SUM` is exact.
Everything above it uses decimals, because values there are displayed or used in fractional
arithmetic, where cents add ceremony and no precision. The `*_cents` columns live only in
`backend/src/db`, which converts them in its row mappers. `backend/src/providers` uses the same
helpers for exact sums, which is the same rounding and not a second boundary.

**`toCents` and the base-amount write round the same way:** half away from zero, `toCents` in
`backend/src/money.ts` and `ROUND(numeric)` in `applyBaseRate` in `backend/src/db`. Change both or
neither.

**A body names its unit once.** A body over all accounts carries a base currency; an account body
carries the account's currency and no base currency. `scope` is a literal, so a reader in
`backend/src/app.ts` or in the client that takes the wrong one fails to compile instead of labelling a
figure with the wrong currency.

**The sign is a convention the type does not carry.** Spending is negative and income positive, in the
row's own currency: the account's, unless the statement had a currency column. `backend/src/providers`
produces it, and the summaries, the classifier and the goals read it. A refund is positive yet reduces
spending in its category, so a reader who takes positive to mean income is wrong on exactly the rows
the classifier exists to separate.

**A refill in progress is reported.** Changing the base currency resets every converted amount and
refills them in the background, because a request cannot wait on the network. `GET /api/conversion`
says whether any refill is running and how many rows lack a base amount, so a client that re-reads
once `converting` is false does not show the gap as data. A refill that finds the base moved stops and
leaves the rest to the refill after the change, so no figure lands in a former base.

**A numeric currency is named from the map, never guessed.** The Monobank feed reports ISO 4217
numbers. `backend/src/rates.ts` files each rate under the code `backend/src/currency.ts` gives it, and
the classifier looks a rate up by the row's letter code. A number missing from the map keeps its rate
under its digits, so a pair that needs it gets no amount check and pairs on the narrow time window
alone. A guess is worse: it files a real rate under the wrong currency, so different money passes as a
pair and a real expense leaves the figures as a transfer.

## Settings and goals

**The environment seeds; the database owns.** The settings table is the truth, or the income source
row for the family patterns. The environment only seeds them, so editing it changes nothing once a row
exists. After that only the base currency reads the environment again, as the fallback for a missing
row; the owner names and family patterns have no fallback. So `backend/src/config.ts` answers for
none of the others at runtime, and the Settings screen is where a person changes these values.
The settings door, the table and the screen all rely on this split, and none of them states it.

**A PostgreSQL connection string changes the engine.** `backend/src/db` reads it to open the database,
and `backend/src/lock.ts` reads it to claim no file, so the two must read it the same way.

**A setting is checked in `backend/src/appsettings.ts`, not at the route.** The update takes a branded
patch, so no caller can pass it an unchecked body. A guard at the route would only move the defect to
the next caller.

### Goals

**Goals are rows, not settings.** Income-source classification stays global, because changing a
source changes every income-based goal. The API replaces a goal's whole configuration and never
changes its type. The debt account cannot change either: its starting debt describes that account and
no other.

**A saved base-currency amount keeps the unit it was entered in.** Goal inputs record the base
currency when written. After the setting changes, current values in another currency become
unavailable rather than relabelled. A current-spending target is unavailable too, because it is
derived in the new unit. Replacing the goal is how the person enters amounts in the new unit.

**A goal's account link is not an account-owned row.** Progress resolves the links against the visible
accounts on every read. The account delete in `backend/src/db` removes account-owned rows, and these
must never join that list.

## What is kept of an upload, and what a crash may leave behind

**A stored statement is the uploaded file, byte for byte, in a folder the person can open.** A better
parser can re-run it, and a bad import can be explained. It stays plain, under a name a person
recognises, because the files are theirs. Why it is not sealed is in `SECURITY.md`.

**It belongs to one import and is deleted with it.** It is named by the import, never by its hash: by
hash, a failed and a committed import of the same bytes would share a file, and deleting either would
reach into the other.

**The name is derived from the row, never stored.** `backend/src/documents.ts` builds it from the
import id, the uploaded filename and the recognised format at every read and delete, so a crafted
backup cannot choose a path. So `backend/src/db` never updates those fields, and every delete passes
all of them. A change to the derivation must not move an existing name: the file would stay under the
old one and read as missing.

**The filename is reduced to a stem every filesystem accepts,** because it is the first user-chosen
string to reach a path. Only the last path segment is kept, its extension dropped, every character
outside letters, marks, digits and a short list replaced, and the length bounded in code points. The
extension comes from the recognised format, and the import id always
follows the stem, so a Windows device name such as `CON` is never a whole name. The shape left to
worry about is a device name before a dot: an upload named `con.txt` with `.csv` after it keeps
`con.txt` as its stem, and Windows reads the part before the dot as the device. So every stem whose part before its first dot is a
device name gets a prefix.

**A name belongs to one row.** A key is read from its right, so the id may not contain `_` and the
format may not contain a dot. `documentKey` refuses a format outside the list in `backend/src/wire`
on every database, and the restore and the column's check in `backend/src/db` stop one earlier. The
id's part of a name is always lowercase, because the default disks on macOS and Windows ignore case.
The stem keeps its case: names whose ids agree belong to one row, and one row has one filename.
Without these, a restored row could spell another row's file, and its delete would unlink the other's
statement. Each part's reason is beside it in `backend/src/documents.ts`.

**The key shape in `backend/src/storage.ts` refuses, never cleans.** The reduction cuts the stem to
what that shape accepts by reading `SEGMENT_START` from it, never by copying it.

**Put, then record, and the order is spread across modules.** On upload, `backend/src/providers`
creates the import row, then puts the file, then records the pointer. `backend/src/db` never records a
pointer before the put, deletes the file whatever the pointer says, and builds the reference a reader
opens a document with; no read skips the hash check. Nothing makes a caller ask it: `DocumentRef` has
no brand, unlike the settings patch, so a hand-built one brings its own hash to compare. The states
this produces:

- **No import row, no document.** The put always follows the row, so there is nothing to sweep for on
  that side.
- **A file whose pointer was never set is the crash window this design accepts.** It is garbage, not
  a lie: nothing claims it, and a delete removes it anyway.
- **A pending or failed import holding a document is not a defect,** for the reason in *Invariants*.
- **A row that claims a file this disk lacks** came from a restore, which carries pointers and no
  files, or its file was removed by hand. The read answers it as not readable.
- **A file whose row is gone is reachable only through the folder.** A restore replaces the import
  rows without touching the folder, so it can leave files behind. There is no sweeper: the folder is
  the person's, and they can see what is in it.

**The store under the naming is a seam and nothing more.** It knows nothing about imports or
filenames, so replacing the local filesystem changes the seam alone. It earns its indirection only
while that stays true.

## What the classifier decides

### Transfers

**The signals that mark a transfer between the person's own accounts are independent on purpose,** so
each covers what the others miss:

- pairing an expense on one account with income on another;
- the owner's name in a description, which catches money from an account this app does not hold;
- a saved description-and-account rule, which covers an outgoing leg whose counterpart is already
  explained and so is never offered for pairing;
- the person's manual flag, in a column of its own that the data layer's classification write never
  touches.

**Similarity is a second reading of the description.** `backend/src/transaction-description.ts`
derives a display name and a value date without changing what is stored. The value-date label it
knows is `Wertstellung`; another bank's label extends that grammar. The matcher on the server owns
case and whitespace normalisation. The client shows the display name and never rebuilds a
matching key from it.

**A restored description can carry a whitespace run of any length.** An upload collapses whitespace in
`backend/src/providers` and a restore does not, which is why the suffix scan in
`transaction-description.ts` reads a run once.

**A rule preview and its write are one contract.** The server computes a preview over the whole
history, never over the client's filtered and capped list, and it names what the write will change.
Applying a similar-description rule replaces every rule in that account's normalized group, an
earlier similar rule included, and clears the manual transfer marks the preview showed. A category
rule leaves manual category choices in place as exceptions. The token binds the write to what the
preview showed.

**The signature carries the transfer rules, match mode included,** so a restart repairs a recompute
that an applied rule left unfinished. Applying a similar-description rule rechecks the preview token
the client sends while holding the account and transaction rows. Removing a rule hands its rows back
to the other signals; it never forces their flags off.

### Categories and income

**One substring test, over rows read whole.** `categoryPatternMatches` is what the classifier, the
preview and the rule counts call. SQL `LOWER` and JavaScript `toLowerCase` disagree on a dotted capital
I and a final sigma, so a preview computed in SQL listed rows the rule then skipped.

**The newest category rule wins.** `backend/src/classify.ts` takes the first rule that matches, from a
list `backend/src/db` orders newest first, and editing a rule keeps its creation time. An edit to any
of the three moves precedence silently.

**A previewed category rule is applied with its token,** which the data layer rechecks under a lock on
what it binds. A request without a token keeps the direct-creation contract.

**The owner names come only from the settings table.** The environment only seeds that row. A person
who leaves it empty gets no owner-name signal, silently and correctly, which neither the classifier
nor the settings screen shows. The family names, the patterns of the builtin `family` income source,
mean the opposite, and the two are easy to swap: an owner name means *not income at all*, a family
name *income from outside*, while that source's kind stays external.

**Categorising a row takes it out of transfer pairing.** Only rows that still look like transfers are
candidates, so every keyword added to `backend/src/categorizer.ts` shrinks the candidate set. A real
transfer whose description holds a merchant word then stays two rows, real income and real spending,
both counted and both wrong. Whoever adds the keyword has no reason to open the classifier, and
nothing holds this.

**A manual Support category reaches the classifier.** On incoming money it blocks amount-based
pairing: it is the per-row form of the exclusion for income a source pattern explains. A Support row's
income source is derived when read, and the source route refuses to override it, so help cannot look
like earnings while the summaries treat it as help.

**An income source pattern below the word floor matches nothing, not everything.** It is dropped, and
a source left with no pattern leaves the matcher. The route accepts such a pattern and the screen says
nothing, so the person is not told.

### When the classifier runs again

**The tagging rules have a signature:** the categoriser's version, the owner names, the income
sources' patterns, and the category and transfer rules. A start whose signature differs recomputes
every transaction. The version lives in `backend/src/categorizer.ts` and has to move with every rule
list in that file, the MCC tables included; an edit without it is invisible.

**Every door that changes a rule, or the rows the rules read, recomputes.** The recompute is full, so
running it twice is running it once. A new door that forgets to call it fails silently.

**A write to the rows the rules read leaves a recompute owed.** The signature covers rules, not rows,
so a crash between such a write and its recompute would go unnoticed at the next start. So each such
write in `backend/src/db` (rows inserted, an import or account deleted, a restore, a manual category
entering or leaving Support) replaces a record in `meta` inside its own transaction, and a start
recomputes while that record is unpaid. A new writer that skips it fails silently.

**Runs go one at a time,** because the data layer's re-tag holds no transaction, and two runs side by
side overwrite each other's pairings. A queued caller also waits out the network waits of the run
ahead: the pairing rates and the base-amount refill.

**A run pays the debt it loaded,** and `setClassifyStamp` marks it paid in the statement that writes
the signature. The record stays out of the signature: every database compares that string at its next
start, so adding to it would make each of them recompute once, and a start could no longer say
whether the rules or the rows sent it.

**A hidden account's transactions stay in the classifier's read,** because they are the other leg of
a transfer to a visible account. That read must not filter by `VISIBLE_ACCOUNT`; the reason sits
beside the filter, not beside the read.

## Rates and derived figures

**The rate sources answer different questions and must not stand in for each other.**
`backend/src/fxrates.ts` answers what an amount was worth in the base currency on its day; it is cached
in the database and fills base amounts. `backend/src/rates.ts` answers whether two amounts could be the
same money, for pairing, from memory. Making one serve both would put a live rate into a stored
figure.

**A historical rate never changes, so its cache never expires.** `backend/src/db` owns the table. A
new kind of row in it is added beside the old ones and never reinterprets them, because old caches are
still read.

**A remembered no-rate answer lives in `meta`, apart from the rates,** so no reader of the rate cache
can take it for a rate or for an absence, and a rate stored for the same key wins over it. Why it
expires is beside `MISS_AGE_MS` in `backend/src/fxrates.ts`.

**A rate that cannot be resolved leaves the row unconverted,** never a zero or a wrong pair's rate,
either of which would put a wrong number into every figure downstream unnoticed. A later recompute
retries it, and the log line says when. Saying nothing has a bounded cost; guessing does not.

**A derivation whose content is its arithmetic lives whole in the code, beside what it governs.** This
spec only names them:

- the goal progress formulas, in `backend/src/goals.ts`. They cross the goal configuration rows, the
  data layer's account and monthly aggregates, and the wire answer that lets every client render
  without recomputing;
- the decimal-to-minor-unit rounding, beside `toCents` in `backend/src/money.ts`;
- the transfer-pairing windows, beside each constant in `backend/src/classify.ts`.

Splitting one of these between this spec and the code is what the rule prevents: a chain whose parts
each check out locally and whose sum nobody owns.
