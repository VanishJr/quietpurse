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
  the JSON parser's ceiling bounds a body before anything parses it. The per-format caps that apply
  *after* a decode are `backend/src/providers`' and are stated there; neither document repeats the
  other.
- **The order of the chain**, which is the next section.
- **Cross-origin access.** The allowlist is `config.corsOrigins`, and a same-origin deployment — the
  Vite dev proxy, or a host proxying `/api` — never sends a cross-site `Origin` and skips this layer
  entirely, which is why a header missing here is invisible in development and absent only in the
  deployed image.
- **Which of the auth provider's endpoints are reachable.** better-auth's organization plugin is
  mounted for its schema and its membership model, and mounting it publishes its whole management
  surface — create, delete, invite-member — on this server as a side effect. Nothing in the app
  calls any of it: the session middleware picks a workspace out of the membership table directly. So
  the door closes that prefix outright, and it stays closed until multi-user workspaces are built.

What the door does not own: how a statement is recognised or parsed, what a query is scoped to, how
a document is sealed, or what the categoriser decides. Each of those refuses on its own terms and
the door reports the refusal. Not being the door's does not put a rule outside this document:
sealing a document and deciding a category happen in this directory and are answered for below,
while recognising a statement and scoping a query happen in directories that carry their own spec.

## The order the chain enforces, and what may not be mounted above it

The chain is not a list of independent layers. What it enforces sits on the edges between its
mounts rather than inside any of them, and an edge is silent when it breaks: nothing fails loudly
when a mount moves.

**The auth provider's own handler is mounted above the JSON parser**, because it consumes the raw
request body itself. A parser above it leaves it nothing to read.

**Nothing that parses a body is mounted above the session check.** A parser above it lets anyone who
can reach the port make the server chew through a body-sized allocation per request, for free,
without ever presenting a credential. The multipart parser obeys the same rule by being mounted per
route rather than globally.

**Every parser that reads a body is mounted through `withWorkspace`.** The session middleware holds
the workspace context for the synchronous run of `next()` and for whatever inherits from it; a
socket is created when the connection is accepted, outside that run. So a parser that finishes on a
later socket read calls `next()` with an empty store and the handler's first query throws. A browser
streams a multipart body, so that is every real upload.

A parser mounted bare may appear to work anyway, and that is the trap. `body-parser` hands `next()` a
plain callback in exactly the same way, and survives today only because `raw-body` binds its callback
through an `AsyncResource` — that package's choice, not a rule this application may rest its central
invariant on. A parser whose package does not make that choice fails silently, in exactly the
direction `backend/src/db/workspace.ts`'s throw exists to make loud. The rule is therefore stated as
a refusal to depend on the binding at all, and `backend/test/workspace-scope.test.ts` holds the
wrapper's own behaviour.

**Membership is the only check.** A session's workspace becomes the ambient scope for every query in
the request, and there are no per-role permissions inside a workspace — companies are out of scope,
and a role check added anywhere would be the first of a system nothing here describes. A workspace
the user has left never wins; a user with no workspace at all is given one here rather than refused,
because the registration hook that normally builds one is not transactional with the user row —
better-auth owns that insert — and a stranded account beats no account.

## Where the boundary runs

**The application is separable from the process that starts it.** `backend/src/app.ts` exports an
app that has connected to nothing; `backend/src/index.ts` is what connects the database, wires the
auth handle and listens. The separation exists so the middleware chain — the session check and the
workspace scoping, which exist nowhere else — can be driven over real HTTP against an embedded
database. Anything that reaches out to the world at import time breaks that and breaks it silently:
the app still imports, and the tests then run against a process that has already done half a boot.

**A value is normalised at the door that writes it, once.** The account doors upper-case a currency
because an account stored as `usd` lists every one of its own transactions as foreign to it on
Overview. Nothing downstream re-normalises: `backend/src/providers` stages an account's currency as
it read it off the row, deliberately, so that a restored `eur` is not silently rewritten by an import
that asked for nothing of the kind. A second `.toUpperCase()` to remember is a second one to forget.

**One refusal here is made safe by a clause in the data layer.** A builtin income
source is editable here and refused by the delete route, so a workspace that predates a change to a
seeded label can reach the word it wants — and what makes that safe is that `upsertIncomeSource`'s
conflict clause does not set `builtin`, so a rename cannot turn a builtin into something deletable.
That clause lives in `backend/src/db` and an edit to it breaks this route.

**A user-chosen filename never reaches a header through a guard believed to be a sanitiser.**
`backend/src/storage.ts` records that `original_filename` is the user's string; the download route
therefore builds its whole `Content-Disposition` value in one place, so that a CRLF cannot split the
response, a quote cannot end the quoted string early, and a character above U+00FF cannot make the
header call throw on a download that otherwise worked.

## What a route owes a caller

**4xx is the caller's fault and 5xx is the server's, and the split is about the operator's alerting
as much as the user's screen.** A refusal the server caused stays 5xx even when the user can act on
it. What a route may change is the *body*: the global handler answers `internal error` and puts the
real message in the log — it tends to carry table names and SQL fragments — and a route with
something more useful to say answers it itself rather than falling through. On the one screen whose
job is telling a person whether their rows landed, `internal error` reads as transient and invites
the same failing press again, so that route's own sentence names the way out instead.

**One route answers without a session.** The health endpoint is the single exemption in the session
middleware, and it doubles as the probe the web client reads *before* anyone can sign in — it says
whether registration on this server needs an invite code, so the sign-up form knows whether to ask
for one. A field added to that response is a field a signed-out stranger can read.

**An identifier that names nothing is answered the same way whatever the reason.** Reads are
workspace-scoped, so another workspace's id and an id that never existed reach the same code path
and get the same sentence. A sentence per case would turn the route into an existence oracle. The
wording is a second choice with a reason of its own: the download route says the document is not
*readable*, never that it is not *kept*, because the bytes of a restored row outlive the stripping
of its pointer.

**A summary body states its own scope.** Without an account it is the whole workspace in the base
currency; with one it is that account alone in the account's own currency, and the body says which.
Transfers between the user's own accounts are out of the income and expense figures on both arms,
and refunds are subtracted from spending in their own category. The per-account monthly arm answers
a `net` as well — every row of the month summed, transfers included, which is what lets the bars add
up to the balance shown beside them over a window covering the account's whole history, and over a
shorter one they add up to that window's movement and the balance does not.

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

**Refuse first, listen last.** A production boot on development secrets and a document store nobody
can write to are both refused before the port is open, because the alternative is discovering either
one through the first user whose import fails.

**Connect and migrate before anything touches the data layer**, including the auth wiring, which
needs the handle.

**Seeding runs for every workspace on every start, unconditionally.** That is the upgrade path: a
builtin setting or income source added in a new version has to reach workspaces that were seeded by
an older one, and there is no migration that can do it because the rows are per-workspace. What
makes the unconditional call cheap rather than destructive is that `seedDefaults` in
`backend/src/db` inserts on conflict do nothing — an edit that changes that breaks this loop from a
file whose author will never open this one.

**The recompute is deliberately not awaited.** It fetches exchange rates, so awaiting it would hold
the port closed on a third party's availability.

## The invariants no type and no test holds

**Nothing is committed on upload.** The upload route parses the file, stages the rows and answers
with a summary to accept; nothing on any screen moves until the confirm route is called. A file this
workspace has already committed is recognised as a duplicate and is not parsed again. This is the
promise the whole ingestion surface is built to keep, and the door is where it can be broken in one
line.

**The stored statement outlives the import that failed.** The download is offered whatever the
import's status, because a failed or a discarded import's document is exactly the artefact worth
having kept — the status gates nothing on that route, on purpose.

**Erasure is a route, not a cleanup.** Removing a stored statement while keeping the import row, its
transactions and its provenance is how a data-subject erasure request is discharged, and it is the
reason that route exists at all rather than being folded into deleting the import. Its ordering —
bytes first, pointer second — is stated beside the code, because the two crash windows are not
equivalent and only one of them is recoverable.

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

**A body names its own unit, once.** A workspace body carries a base currency, an account body
carries the account's own currency and no base currency, and `scope` is a literal rather than a
field that happens to be there — so reading the wrong one is a compile error instead of a figure in
one currency labelled another. `## What a route owes a caller` says what each scope covers; this is
the rule that keeps the two readable apart.

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

## What a deployment must supply, and what the app decides for itself

**The environment seeds; the database owns.** Several values exist in both places, and for each of
them the settings table — or, for the family patterns, the income source row — is the source of
truth. What the environment does is seed, and the seeding is the loop `## What the process entry
owes the app` describes: it runs for every workspace on every start and inserts nothing where the
row is already there, so editing the environment moves a value only where no row has been written
yet. After that only the base currency reads the environment again, as the fallback for a missing
row; the owner names and the family patterns have no fallback at all and answer empty when their row
is absent. `backend/src/config.ts` is therefore not where a base currency, an owner name or a family
name is answered from at runtime. That split is read from three directions — the settings door, the
settings table and the screen — and is stated in none of them.

**That the owner names have no fallback is deliberate.** They are one household's, so falling back
to the operator's own would put their names in a stranger's settings screen; the seed reaches every
workspace as a row instead, empty for all but the first. An environment fallback here is not a
convenience, it is a cross-workspace leak with no query to blame for it.

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

**A stored statement belongs to one import and dies with it.** The blob is keyed by the import id
and never by the content: keying by the file's hash would let a failed import and a committed one of
the same bytes share a blob, so deleting either would reach into the other. It is kept encrypted at
rest because the reason for keeping it at all is that a better parser can re-run it later and that
*my import came out wrong* is answerable.

**The ordering is put, then record, and it is enforced across three modules that each hold a piece
of it.** `backend/src/providers` puts the bytes only after the import row exists and records the
pointer only after the put; `backend/src/db` never records a pointer before the put, composes the
reference a reader opens a document with — asking it is the honest way to obtain one, and it offers
no overload that skips the hash check — and deletes the blob whatever the pointer says. Nothing in
the type enforces the asking: `DocumentRef` is three plain fields with no brand, so a caller who
assembles one by hand hands the check its own hash to compare against, unlike the branded settings
patch above, where the compiler really does refuse an unchecked body. No single line holds that
chain, which is why the states it produces are ruled on here rather than left to be discovered:

- **An import row that never existed cannot hold a document.** The put is strictly after the row is
  created, so there is no orphan on that side to sweep for.
- **Bytes on disk whose pointer was never set are the crash window this design accepts.** It is on
  the garbage side rather than the lie side: nothing claims a document that is not there, and the
  delete path removes the blob unconditionally, so those bytes stay collectable by the ordinary
  route.
- **A pending or a failed import holding a document is not a defect, and the failed case is the
  point.** The input is what a person diagnosing a bad import needs, and it is the artefact most
  worth having kept.
- **A blob whose row no longer exists at all is reachable by nothing.** A restore replaces a
  workspace's import rows without touching the store, so a restored workspace can leave bytes
  behind. No sweeper is in scope: that is a data-deletion question rather than something a storage
  module fixes on the side.

**A key layout is added by adding an entry, and there is no version list anywhere that can be
forgotten.** The writer uses the newest layout, the row records which one it used, and the delete
tries every layout this server knows. What a layout may be built from is deliberately narrow — only
what the delete path can supply from the row it is deleting — so widening a layout and widening that
select are one change the compiler will not let happen by halves.

**The workspace segment of a key is the raw id and not a hash of it.** Hashing would guarantee the
segment always satisfies the store's charset, which turns *a workspace id this system did not
expect* from a loud refusal into a silently accepted value; and an operator answering *delete
everything for workspace X* could no longer do it with `ls` and `rm`.

**Every id this server generates has to be inside the store's charset, and that is owed by whoever
mints one.** An id outside it refuses every upload in the workspace concerned, with a message that
blames the disk — loud, far from its cause, and not obviously about ids at all. The rule reaches
past this repository's own generators: it is owed by a dependency whose alphabet this application
does not control and must not assume.

**Key rotation's exit is recorded before it is needed.** The day a second sealing key is held the
reader picks by the id stamped in the envelope, and two keys whose derived ids collide are
indistinguishable; the stamp cannot be widened for documents already written. So the exit is that
boot refuses two configured keys with the same derived id and the operator regenerates one — not a
wider stamp, and not a guess at read time.

**The store below the sealing is a seam and nothing more.** It knows nothing about workspaces,
imports or encryption — `backend/src/documents.ts` seals the bytes and hands it an opaque key — which
is what makes replacing the local filesystem with an object store a change to the seam's own
functions and to nothing else. The seam earns its indirection only while that stays true.

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
workspace that leaves that setting empty gets no owner-name signal at all, silently and correctly.
That is an absence a reader of the classifier cannot see and a reader of the settings screen would
never guess at. The family names beside them work the opposite way and the two are easy to
transpose: an owner name means *not income at all*, a family name means *income, but from outside*.

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
signature differs from the one recorded recomputes the whole workspace. That is the upgrade path, and
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
