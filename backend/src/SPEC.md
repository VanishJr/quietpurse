# backend/src

Status: draft

This document answers for the code that sits directly in `backend/src`: the HTTP door every request
comes through, the process that opens it, and the service modules between that door and the
directories below it. A directory below this one that carries its own `SPEC.md` describes itself;
where a rule here reaches into one, it names that directory and stops. `ARCHITECTURE.md` answers
*where* — which module owns what, and the path one statement takes across them. This answers *why*,
and only for the code that sits directly in this directory. Where both could carry a rule it belongs
to the one whose edit would break it.

The reasoning below used to sit in the module headers, the route docblocks and the field comments of
the files in this directory. What stayed beside the code is what an edit to its own line would break: an
ordering the shape of the chain enforces, a sentinel's meaning, why a clause is absent from one
expression, a rejected alternative a reader will otherwise re-attempt there.

## What this surface owns

The door owns what crosses it and nothing behind it.

- **The wire vocabulary** — the field names, the shapes a body may take, the status codes, and the
  sentences a refusal is written in. A schema at the door is the only thing between a hand-written
  request and a writer that takes a typed value, so the door narrows rather than casts: a predicate
  that answers a boolean leaves a caller's string a string.
- **The refusal sentences themselves.** They are read by a person who is stuck, so each one says
  what to do next rather than what went wrong, and where two states refuse the same write the two
  sentences differ because the ways out differ. A refusal that has to quote something quotes what is
  on the user's screen, not what arrived in the request.
- **The transport caps.** `UPLOAD_LIMITS` bounds a multipart request before anything decodes it, and
  the JSON parser and the restore route's raw parser bound a body before anything parses it. Those
  two read one constant, `MAX_BODY_BYTES`, and the sentence a body over it is refused with is
  composed from the same constant: the body reaches one of the two parsers by content type, so two
  literals would give a client sending JSON one ceiling and a client sending bytes another. The
  multipart cap is a separate constant on purpose — it bounds a different door with its own
  sentences, and the two numbers agreeing is not a rule. The per-format caps that apply *after* a
  decode are `backend/src/providers`' and are stated there; neither document repeats the other.
- **The built client.** Below every `/api` route the door serves what `web/dist` holds, and a GET
  for any path that is not an API path answers the app's own page, so a reloaded `?screen=` URL
  lands where it names. A POST to an unknown path is refused rather than answered with a page, and
  a missing build is answered with the command that makes one rather than with a blank window.

What the door does not own: how a statement is recognised or parsed, how a stored file is named, or
what the categoriser decides. Each of those refuses on its own terms and the door reports the
refusal. Not being the door's does not put a rule outside this document: naming a stored file and
deciding a category happen in this directory and are answered for below, while recognising a
statement and writing a query happen in directories that carry their own spec.

## There is no session, and what that puts on the door instead

**Every request is the one person's.** There is no sign-in, no session and no tenant: whoever can
reach the port is the owner of the data behind it. That is not a hole the door papers over — it is
the product's shape, and what answers for it is the process entry below, which listens on the
loopback interface unless told otherwise. **No middleware asks who is calling** and nothing in a
route records who acted, because there is nobody else to be.

**One middleware asks where the request came from, which is a different question and the only one
left.** Binding to loopback keeps other machines off the port and says nothing about a page in the
owner's own browser, which is on this machine by definition — and with no session to be missing,
such a page is the owner. So every route under the API prefix passes three checks before the body
is parsed, and each closes something the other two do not.

- The `Host` header must be an address and not a DNS name. That is what closes DNS rebinding: a
  page whose own hostname is made to resolve to the loopback address arrives genuinely
  same-origin with itself, and the name in this header is the only part of it still under the
  attacker's control. It also leaves the documented wider bind working, because the phone that
  setting exists for arrives by address.
- An `Origin`, when it is present, must name this server. This is what closes the plain
  cross-origin write, which needs no rebind at all: a multipart body is CORS-safelisted, so any
  page can post a statement here and the browser sends it — the answer is unreadable to that page
  and the import still lands.
- A method that changes state, carrying `Sec-Fetch-Site`, must say `same-origin`. Stated as a
  defence a browser that omits the header does not provide: the two above are what stand behind
  it, not the other way round.

The health route is inside the check with everything else. There is no proxy and no probe that
needs it exempt, and an exemption granted by habit is the precedent for the next one.

**Nothing crosses an origin in normal use, which is why the second check costs nothing.** The Vite
dev server proxies the API to the backend and the start command serves the built client from the
backend itself, so every request the client makes is same-origin: there is no allowlist to
maintain, no preflight and no credential to carry.

**The multipart parser is mounted per route, not globally.** No other route pays for a multipart
parse it never asked for. A body under a content type no parser claims — a form sent to a JSON
route, plain text, or no body at all — reaches the route unparsed with `req.body` undefined, so
every route that reads a JSON body without a schema in front of it reads it through `jsonBody`,
which refuses anything that is not an object with one sentence naming the content type the door
takes, and answers that refusal itself so the route has only to return. One sentence and not two,
because a body-less browser `fetch` and a body under another type are indistinguishable to the
request's own type check once a zero content length is present. An empty JSON object is an object
and passes: the parser hands an empty body over as one, and a route that refuses it turns a no-op
patch into a refusal. The upload route is guarded the other way round — `uploadFile` refuses a
request that is not multipart before the route reads a field, with the sentence the multipart
parser's own refusals use, because a person who sent JSON to the upload door needs to hear
*multipart*, not *JSON*.

## Where the boundary runs

**The application is separable from the process that starts it.** `backend/src/app.ts` exports an
app that has connected to nothing; `backend/src/index.ts` is what takes the lock, opens the
database and listens. The separation exists so the whole route table can be driven over real HTTP
against an embedded database in the suite. Anything that reaches out to the world at import time
breaks that and breaks it silently: the app still imports, and the tests then run against a process
that has already done half a boot.

**A value is normalised at the door that writes it, once.** The account doors upper-case a currency
because an account stored as `usd` lists every one of its own transactions as foreign to it on
Overview. Nothing downstream re-normalises: `backend/src/providers` stages an account's currency as
it read it off the row, deliberately, so that a restored `eur` is not silently rewritten by an import
that asked for nothing of the kind. A second `.toUpperCase()` to remember is a second one to forget.

**One refusal here is made safe by a clause in the data layer.** A builtin income source is
editable here and refused by the delete route, so a database that predates a change to a seeded
label can reach the word it wants — and what makes that safe is that `upsertIncomeSource`'s
conflict clause does not set `builtin`, so a rename cannot turn a builtin into something deletable.
That clause lives in `backend/src/db` and an edit to it breaks this route.

**A user-chosen filename never reaches a header through a guard believed to be a sanitiser.**
`backend/src/storage.ts` records that its key shape is not one; the download route therefore builds
its whole `Content-Disposition` value in one place, so that a CRLF cannot split the response, a
quote cannot end the quoted string early, and a character above U+00FF cannot make the header call
throw on a download that otherwise worked. The stored file's own name goes through a second,
separate reduction, which is `## What is kept of an upload` below.

## What a route owes a caller

**4xx is the caller's fault and 5xx is the server's, and the split is about the log as much as the
user's screen.** A refusal the server caused stays 5xx even when the user can act on it. What a
route may change is the *body*: the global handler answers `internal error` and puts the real
message in the log — it tends to carry table names and SQL fragments — and a route with something
more useful to say answers it itself rather than falling through. On the one screen whose job is
telling a person whether their rows landed, `internal error` reads as transient and invites the same
failing press again, so that route's own sentence names the way out instead.

**The last handler answers a caller's error with the caller's status, and the test for "the
caller's" is the `http-errors` contract.** `errorHandler` passes an error through when it carries a
4xx `status` *and* `expose` true — what body-parser and raw-body throw — and answers everything else
as `internal error` with the object in the log. Both properties are read by property access, never
by an own-key check: on the class-based errors they sit on the prototype. The router's `URIError` for
a path that will not decode carries a status and no `expose`, so it stays a 500 by design rather
than by oversight. A body over the ceiling is answered with the sentence composed from
`MAX_BODY_BYTES`; a body the JSON parser could not read keeps the parser's words behind a prefix
the door owns, because those words describe what the caller sent and are the only hint of where the
stray comma is; any other exposed refusal keeps the parser's own short phrase. The echoed message is
bounded on its way into the body, as every caller-supplied string here is. **The 4xx arm logs one
line of fields it composes and never the error object:** a parse failure carries the whole request
body as an own enumerable property, and pino's serializer copies own properties, so logging the
object on a near-miss under the ceiling is a log line the size of the body. When headers have
already gone out, the handler logs the cause and hands the error on, because the fallback that
closes the socket writes to stderr and not to the structured log.

**An identifier that names nothing is answered with one sentence.** An id that never existed, a row
that claims no document, and a row whose claimed file is not on this disk reach the same answer and
the same words; the download route says the document is not *readable*, never that it is not
*kept*, because a row's claim outlives the machine it was made on. A restore carries the claim and
carries no files, so the third of those is the ordinary state of a backup opened somewhere else and
is not reported as a fault. A file that IS there and does not hash to what the row recorded is the
fault, and it keeps the other status.

**A summary body states its own scope.** Without an account it is every account together in the
base currency; with one it is that account alone in the account's own currency, and the body says
which. The literal that names the first is `all`, beside `account` for the second. It was
`workspace` until Finto became one person's tool, and it was renamed on both sides of the wire in one
diff: the REST API is the contract, and a renamed literal is a different API — which is safe here only
because the client and the server build from one checkout with one command, so no client that asks for
the old word can exist. Transfers between the user's own accounts are out of the income and expense figures
on both arms, and refunds are subtracted from spending in their own category. The per-account
monthly arm answers a `net` as well — every row of the month summed, transfers included, which is
what lets the bars add up to the balance shown beside them over a window covering the account's
whole history, and over a shorter one they add up to that window's movement and the balance does
not.

**A count in an answer is what this call did.** The delete routes report what they actually
destroyed, taken from the deletes themselves, and that is a different fact from the preview a client
showed beforehand — a hidden account's panel counts transactions by summing over the account's
imports, where a row an earlier import already wrote belongs to that earlier import. The confirm
route's `inserted` is the database's own count and can be less than the staged summary promised, if
another import wrote some of those rows in between.

**A list the client edits as a whole is written as a whole.** The saved chart list is one array the
screen already computes — reorder, duplicate-at-position and delete are all the same write — and it
is versioned rather than merged. The refusal carries the current state, so a client refused for
staleness needs no second request to show the truth.

**A restore replaces.** The body of that request is the backup file itself, current data goes, and
everything derived is recomputed afterwards because the backup may predate the current rules.

## What the process entry owes the app

The boot order is a sequence of refusals before anything listens, then the work that may run late.

**One process per folder, and the lock is the process's own.** The embedded database does not
refuse a second opener: two processes on one data directory write over each other's files with
nothing failing, which was measured rather than assumed. So the entry writes its pid into a lock
file beside the data before it opens anything, refuses to start while another live pid holds it,
and takes a dead pid's lock over — a crash leaves a file, not a locked-out person. The lock is not
taken when a PostgreSQL server is configured instead; that server has its own.

**Refuse first, listen last.** A folder for the statements that nobody can write to is refused
before the port is open, because the alternative is discovering it through the first upload that
fails.

**Loopback unless told otherwise.** With no sign-in, a server reachable from the network is a
database reachable from the network, so the entry binds the loopback interface by default and
prints where it is. The one reason to bind wider is a phone on the same Wi-Fi, and the setting that
does it says in `backend/.env.example` what it exposes.

**Seeding runs on every start, unconditionally.** That is the upgrade path: a builtin setting or
income source added in a new version has to reach a database seeded by an older one, and there is
no migration that can do it because the rows carry a person's edits. What makes the unconditional
call cheap rather than destructive is that `seedDefaults` in `backend/src/db` inserts on conflict do
nothing — an edit that changes that breaks this boot from a file whose author will never open this
one.

**The recompute is deliberately not awaited.** It fetches exchange rates, so awaiting it would hold
the port closed on a third party's availability.

**Stopping is a close, not a kill.** The embedded database is closed on the signal a terminal sends,
and the lock goes with it, so the next start does not meet a live-looking lock from a process that
was told to stop.

## The invariants no type and no test holds

**Nothing is committed on upload.** The upload route parses the file, stages the rows and answers
with a summary to accept; nothing on any screen moves until the confirm route is called. A file
already committed is recognised as a duplicate and is not parsed again. This is the promise the
whole ingestion surface is built to keep, and the door is where it can be broken in one line.

**The stored statement outlives the import that failed.** The download is offered whatever the
import's status, because a failed or a discarded import's document is exactly the artefact worth
having kept — the status gates nothing on that route, on purpose.

**Erasure is a route, not a cleanup.** Removing a stored statement while keeping the import row, its
transactions and its provenance is what the delete-document route is for, and it is the reason that
route exists at all rather than being folded into deleting the import. Its ordering — file first,
pointer second — is stated beside the code, because the two crash windows are not equivalent and
only one of them is recoverable.

**Nothing enforces any of this.** No type carries the order of a middleware chain, and no test can
tell a reason that was moved from one that was dropped. The checks in this repository that read a
source file as text each name their target as a literal in their own source, and none of those
literals names a file that sits directly in this directory — so a banner, an ordering, a mount or a
convention removed from one of these files reds nothing. A rule stated here and broken in the code
is green.

## What a figure is denominated in

**Money crosses one boundary and it is deliberately narrow.** The database holds an integer count of
minor units, so a `SUM` stays exact and no reader has to know about a float; everything above it —
the domain types, the JSON bodies and the client — works in decimals, where a value is either
displayed or fed into genuinely fractional arithmetic and integer cents would add ceremony without
adding precision. The `*_cents` **columns** live only in `backend/src/db`, which converts them in
its row mappers. The conversion **helpers** are not confined there: `backend/src/providers` uses
them wherever exact integer arithmetic is wanted, which is the same rounding applied to a sum rather
than a second column boundary. Why that rounding is what it is, and the float that forces it, are
written whole beside `toCents` in `backend/src/money.ts`.

**A body names its own unit, once.** A body over every account carries a base currency, an account
body carries the account's own currency and no base currency, and `scope` is a literal rather than
a field that happens to be there — so reading the wrong one is a compile error instead of a figure
in one currency labelled another. `## What a route owes a caller` says what each scope covers; this
is the rule that keeps the two readable apart.

**A sign is a convention the type does not carry.** An amount is negative for spending and positive
for income, in the account's own currency, and a refund arrives positive while subtracting from
spending in its own category — so a reader who takes a positive amount to mean income is wrong about
exactly the rows the classifier exists to separate.

**An absent figure is an answer, and a present one is a claim.** A base-currency amount is absent
while no rate has been fetched for that row's date, never zero. A list of an account's foreign
currencies is required rather than optional, because empty means *checked, and there are none* where
absent means nobody looked. A fee is absent on the way out and null on the way in, never a zero this
importer invented. None of those distinctions is visible in the type, and each is the whole content
of the field.

**A currency that arrives as a number is named, and one that is not in the map is not guessed at.**
The numeric-to-alphabetic map exists because the live rate feed reports currencies as ISO 4217
numbers, and every reader of the rates built from that feed looks one up by three-letter code — the
door accepts nothing else as a currency. A number off the end of the map files its rate under the
digits, where no such lookup reaches it, and the cross-currency pair that needed the rate quietly
fails to pair. Nothing shows the number to anybody, so that is the whole of the consequence, and it
is the cheaper failure: guessing a three-letter code would file a real rate under a currency it is
not, which pairs two amounts that are not the same money and takes a real expense out of the figures
as a transfer.

## What the environment supplies, and what the app decides for itself

**The environment seeds; the database owns.** Several values exist in both places, and for each of
them the settings table — or, for the family patterns, the income source row — is the source of
truth. What the environment does is seed, and the seeding is the call `## What the process entry
owes the app` describes: it runs on every start and inserts nothing where the row is already there,
so editing the environment moves a value only where no row has been written yet. After that only
the base currency reads the environment again, as the fallback for a missing row; the owner names
and the family patterns have no fallback at all and answer empty when their row is absent.
`backend/src/config.ts` is therefore not where a base currency, an owner name or a family name is
answered from at runtime, and the Settings screen is where a person changes them. That split is
read from three directions — the settings door, the settings table and the screen — and is stated
in none of them.

**Nothing is required to start.** Every value the environment can supply has a default that works
on a machine with nothing installed: the home folder under the person's own home directory, the
embedded database inside it, the statements folder beside that, loopback, port 4000. A PostgreSQL
connection string is the one setting that changes an engine rather than a value, and two places
read it: `backend/src/db`, where the database is opened, and the process entry, which skips the
lock file when it is set — `## What the process entry owes the app` above says why that server
needs none.

**A setting that cannot be stored is refused, never coerced.** An absent key in a patch means *leave
it alone*; a present one that is not a value this system can hold is a refusal, because `EURO` is
not somebody's guess at `EUR` and a 200 on a change that never happened is the worst answer
available. What makes that structural rather than a habit is that the update takes a branded patch
and cannot be called with an unchecked body at all — a guard at the route would only move the defect
to the next caller, which is where it was found the first time.

**The Goal screen's settings are one JSON string rather than a table, and the shape has a cost.**
There are few of them and a table would not pay for itself; what that buys in ceremony it takes back
in checking, because no column type bounds anything. The unit a field is denominated in, and the
meaning of a sentinel where a field has one, are therefore stated on the field in
`backend/src/settings.ts`; the numeric bounds are in the update's own clamping, which is also the
only thing between a hand-written body and a threshold computed from a window nobody could live in.

## What is kept of an upload, and what a crash may leave behind

**A stored statement is the uploaded file, byte for byte, in a folder the person can open.** It is
kept because a better parser can re-run it later and *my import came out wrong* is answerable — and
it is kept plain, under a name a person can recognise, because the whole point of the folder is
that the files in it are theirs. Sealing them was the hosted product's answer to a disk somebody
else could reach; on one person's own machine that disk is the person's, and what protects it is
the machine's own encryption, which `SECURITY.md` states as the trade it is.

**A stored statement belongs to one import and dies with it.** The file is named by the import and
never by the content: naming by the file's hash would let a failed import and a committed one of
the same bytes share a file, so deleting either would reach into the other.

**The name on disk is derived from the row and never stored on it.** Three fields name a file — the
import id, the filename the person uploaded and the format the bytes were recognised as — and none
of them changes after the row is written, so the name is derived again at every read and delete. A
stored path is a string a crafted backup gets to choose, and a derived one is not. The consequence
is stated so nobody widens it by halves: a field that names a file may not be updated, and a delete
has to carry all three.

**The filename is the first user-chosen string ever to reach a path, and the reduction is total.**
The last path segment only, its extension dropped, every character outside letters, marks, digits
and a short list replaced, the whole bounded by code points and never by UTF-16 units. The
extension comes from the recognised format, never from the name. The stem never stands alone: the
id follows it before the first dot, which is what keeps `CON`, `NUL` and the other Windows device
names from ever being a whole name — except where a dot inside the stem would end the name early,
and that one shape is prefixed.

**The stem's leading edge is cut to what the key shape will OPEN a segment with, read off that
shape rather than copied.** The two are in different files, and the three classes a key segment
uses are not the same: a dot, a space and a closing parenthesis are all legal inside a segment and
none of the three begins one. Copied by eye, the closing parenthesis was missed — so a filename
starting with one produced a key the guard threw on, and the upload was refused with a sentence
about an unwritable folder, for that file, forever. The guard behind all of it is
`backend/src/storage.ts`'s key shape, which refuses anything the reduction did not produce rather
than cleaning it up; what keeps the two in agreement is not the two comments matching but
`backend/test/documents.test.ts`'s property case, which drives the stem's whole character set
through both doors, one character at a time and in every position.

**The hash is checked on read, and a file edited in the folder is refused.** A person who opens a
statement in a spreadsheet and saves it has a different file under the same name; handing it back
as the upload would be a re-import of their edits. The refusal is 5xx with the person's words about
nothing having been sent, and the log names the file.

**The ordering is put, then record, and it is enforced across three modules that each hold a piece
of it.** `backend/src/providers` puts the file only after the import row exists and records the
pointer only after the put; `backend/src/db` never records a pointer before the put, composes the
reference a reader opens a document with — asking it is the honest way to obtain one, and it offers
no overload that skips the hash check — and deletes the file whatever the pointer says. Nothing in
the type enforces the asking: `DocumentRef` is plain fields with no brand, so a caller who assembles
one by hand hands the check its own hash to compare against, unlike the branded settings patch
above, where the compiler really does refuse an unchecked body. No single line holds that chain,
which is why the states it produces are ruled on here rather than left to be discovered:

- **An import row that never existed cannot hold a document.** The put is strictly after the row is
  created, so there is no orphan on that side to sweep for.
- **A file on disk whose pointer was never set is the crash window this design accepts.** It is on
  the garbage side rather than the lie side: nothing claims a document that is not there, and the
  delete path removes the file unconditionally, so it stays collectable by the ordinary route.
- **A pending or a failed import holding a document is not a defect, and the failed case is the
  point.** The input is what a person diagnosing a bad import needs, and it is the artefact most
  worth having kept.
- **A file whose row no longer exists at all is reachable by nothing but the folder.** A restore
  replaces the import rows without touching the folder, so a restore can leave files behind. No
  sweeper is in scope: the folder is the person's, and they can see what is in it.

**The store below the naming is a seam and nothing more.** It knows nothing about imports or
filenames — `backend/src/documents.ts` derives a name and hands it an opaque key — which is what
makes replacing the local filesystem with anything else a change to the seam's own functions and to
nothing else. The seam earns its indirection only while that stays true.

## What the classifier decides, and what it is coupled to

**The signals that say a transaction is a transfer between the user's own accounts are independent
on purpose.** A card-to-card move appears twice — an expense on one account and income on another —
so one signal is pairing those halves, across currencies too, where the amounts are checked against
a rate instead of each other. Another is the owner's own name in the description, which catches
money arriving from an account this app does not hold. Another is a saved description-and-account
rule, which is what covers an outgoing leg whose counterpart is already explained and therefore
never offered for pairing. The last is the user's manual flag, in a column of its own that the
classifier never writes. A transaction already explained is not offered for pairing at all, because
offering it is how a real cash expense disappears from the figures.

**The owner names are the only source that signal has.** They come from the settings table and from
nowhere else — the bank-supplied account-holder name left with the deleted integrations — so a
person who leaves that setting empty gets no owner-name signal at all, silently and correctly. That
is an absence a reader of the classifier cannot see and a reader of the settings screen would never
guess at. The family names beside them work the opposite way and the two are easy to transpose: an
owner name means *not income at all*, a family name means *income, but from outside*.

**Categorising a row takes it out of transfer pairing, and the coupling runs in the direction nobody
looks.** Only rows that still look like a transfer are offered as pairing candidates, so every
keyword added to `backend/src/categorizer.ts` moves rows out of the unrecognised bucket, and every
row that moves leaves the candidate set. A genuine transfer whose description happens to carry a
merchant word then stays two rows — real income on one account, real spending on the other, both
counted, both wrong. The person adding the keyword is not editing the classifier and has no reason
to open it. Nothing holds this.

**An income source's patterns are matched by words, and a pattern below the floor matches nothing
rather than everything.** The match is over the set of words rather than the string, with a floor on
how many long-enough words a pattern must reduce to; a pattern that falls below it is dropped, and a
source whose only pattern was dropped leaves the matcher entirely. Nothing on the screen where a
person types that pattern says so, and nothing refuses it either.

**The tagging rules have a signature.** The categoriser's own version, the owner names, the income
sources' patterns and the user's category rules are composed into one string, and a start whose
signature differs from the one recorded recomputes every transaction. That is the upgrade path, and
it is also the trap: a rule list edited in `backend/src/categorizer.ts` without its version moving is
a change the signature cannot see, so every existing row keeps a tag the current rules would not give
it. A source's *kind* is deliberately outside the signature — it moves summaries and not tags.

**The recompute is driven from the doors that change a rule or the rows the rules read, and from a
startup check on the signature**, and it is a full recomputation from each transaction's own source
fields rather than an increment, so no state accumulates and running it twice is running it once. A
door that changes something the signature does not carry recomputes for itself; nothing about the
signature makes that unnecessary.

**A hidden account's transactions stay in the database.** Hiding an account takes it off the screen
and its rows out of the figures; it does not delete them, because the classifier still needs them as
the other leg of a transfer to an account that is visible. Dropping them would quietly turn every
such transfer back into an income and an expense.

## What a rate is, and where a derived figure is written whole

**Two rate sources answer two different questions and are not interchangeable.** One answers *what
was this worth in the base currency on the day it happened*, is cached in the database and is what
fills a transaction's base-currency amount; the other answers *are these two amounts plausibly the
same money*, for the classifier's cross-currency pairing, and is held in memory for minutes. Neither
is a fallback for the other, and a change that made one serve both would give a stored figure a live
rate.

**A historical rate does not change, so its cache never expires.** What that commits this code to is
the row format: rows written by the first version are still read by the current one, so a shape in
that cache is changed by adding another and never by reinterpreting the one already there.
`backend/src/db` owns the table; this is the rule about what may be written into it.

**No provider covering a pair is an error in the log, never a silent absence.** A rate that cannot
be resolved leaves the row unconverted and says so; the alternatives — a zero, or a rate from the
wrong pair — put a wrong number into every figure downstream with nothing to notice it. An
unconverted row is picked up by the next recompute, so the cost of saying nothing is bounded and the
cost of guessing is not.

**A derivation whose content is its arithmetic is written whole in the code, at the site it governs,
and this document says only that it exists.** Each is stated once and in one place:

- the independence thresholds — the two bases, the buffer, the shortfall, the self-sufficiency
  ratio, the whole-months window and the one-off amortisation — in `backend/src/independence.ts`'s
  header. It crosses `backend/src/settings.ts`'s bounds, `backend/src/db`'s baseline and monthly
  totals, and `web/src`, which answers for which of the two modes a figure was actually computed in.
- the decimal-to-minor-unit rounding, beside `toCents` in `backend/src/money.ts`.
- the two transfer-pairing windows, beside each constant in `backend/src/classify.ts` — a wide one
  where the amounts have to match exactly, a narrow one where they cannot.

Splitting one of those between here and the code is the failure the rule exists to prevent: a chain
whose parts are each locally checkable and whose sum nobody owns.
