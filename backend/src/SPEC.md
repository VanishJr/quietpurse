# backend/src

Status: draft

This document is `backend/src`'s outermost layer: the HTTP door every request comes through, and the
process that opens it. A directory below this one that carries its own `SPEC.md` describes itself;
where a rule here reaches into one, it names that directory and stops. `ARCHITECTURE.md` answers
*where* — which module owns what, and the path one statement takes across them. This answers *why*,
and only for the code that sits directly in this directory. Where both could carry a rule it belongs
to the one whose edit would break it.

The reasoning below used to sit in the headers and the route docblocks of `backend/src/app.ts` and
`backend/src/index.ts`. What stayed beside the code is what an edit to its own line would break: an
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
the door reports the refusal.

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
because the registration hook that normally builds one is not transactional with the user row and a
stranded account beats no account.

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
source file as text are pointed at particular files by name, and none of them is pointed here — so a
banner, an ordering or a mount removed from these two files reds nothing. A rule stated here and
broken in the code is green.
