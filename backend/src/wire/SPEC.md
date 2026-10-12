---
id: submodule-backend-wire
type: submodule-design
status: draft
title: The declared answer of every route
parent: module-backend
---

## Responsibility

**Every route's answer, declared once.** Each 2xx JSON body is a zod schema here, and `ANSWERS` keys
it by method and path exactly as Express registers the route. The refusal envelope `{ error }` is
declared too, and so is the one richer refusal: the charts route's stale 409, which carries the
current version and list.

**The backend's types are inferred from these schemas.** No file in `backend/src` writes a wire
shape by hand. A module may narrow one (`Omit`, `Exclude`, `Extract`, a brand) or recompose it from
the wire's pieces, and add what the wire lacks, as `NewTransaction` in `backend/src/types.ts` and the
ingestion surface's `ImportSummary` do. Writing a shape's fields out again makes a second
declaration, which matches the route only by luck.

**The vocabularies and bounds the client builds against**: chart kinds, ranges, breakdowns, measures
and bounds; the chart id charset; import source types and statuses; income-source kinds; goal types,
bases, income scopes, progress semantics, units, statuses, periods and bounds; the reasons a balance
pair is not shown; and `ERROR_DETAIL_MAX`. `backend/src/db` imports these tuples, never the reverse.

**The chart id charset is a string, `CHART_ID_SHAPE_SOURCE`, beside the `RegExp` built from it**,
because a type can carry a string but not a pattern. The client cannot import the `RegExp`, since a
value import would bundle this package. It builds its own from a string pinned by type to the wire's.
Narrowing the charset here without the client is then a compile error in `web/`, instead of a client
that keeps sending an id the route refuses and loses the whole list over it.

**Goal requests are part of the public contract.** Their strict create and replacement schemas live
here for future clients; other request schemas are local to `backend/src/app.ts`, built on the tuples
here, with their own refusal sentences. Money is accepted only in whole cents and savings-rate
targets only in whole basis points, because a value the integer columns would round is not a valid
request. A Financial independence summary carries the required work hours, the server's monthly
capacity and whether it is exceeded, so the weekly hours a person enters actually count. The client
pins each goal union to its tuple and formats progress from the answer's semantic and unit, never
from the goal type.

**`SUPPORT_INCOME_SOURCE` is the read-only income source derived from the Support category.** Its
namespaced id cannot be created through the API, it is not in the editable source list, and it
always counts as external income.

## Boundary

`backend/src/SPEC.md` covers what comes in: the request schemas, the refusal sentences and which
status a refusal gets. This spec covers what goes out.

**This module imports only zod and its own files**, not even types from elsewhere. The client's
typecheck compiles this file and everything it imports, so one data-layer type would pull
`drizzle-orm` into the client. That is why the vocabularies live here. `backend/test/wire.test.ts`
checks every import form, including `require`, `import()`, `typeof import()` and triple-slash
directives.

**The client's compiler compiles this file too.** `web/src/types.ts` re-exports its types, so the
client's stricter `tsc` (`isolatedModules`, `noUnusedLocals`, `noUnusedParameters`) reads it. A type
re-export without `export type`, or an unused local, passes both backend jobs and fails the `web`
job. So every type-only re-export uses `export type` and nothing is left unused. Nothing catches a
`const enum`, a `__dirname` or a `require('zod')`.

## What a declaration says, and how it is read

**Every object is strict**, and `backend/test/wire.test.ts` holds it and says why.

**Optionality follows what the producer emits, read from the mapper.** A field set on every row is
required; a field a producer omits is optional. Absent and `null` are different answers and are
declared apart; the field's own docblock says which is which. An account's list of foreign
currencies is required, because empty means "checked, none" and absent would mean "never checked". A
flag that is only ever `true` (a delete, a discard, a restore, health) is declared as the literal;
the client may read it as a boolean and lose nothing.

**A value a screen shows as prose crosses as a slug**: the reasons a balance pair is not shown,
categories, income-source ids. The client's dictionary holds the words.

**A currency crosses in one form.** Every currency an answer carries is declared with
`currencySchema`, and `sentForm` folds each one with `currencyKey` before `answer()` in
`backend/src/app.ts` sends it, so a stored `eur` reaches every client as `EUR` and a client compares
currencies letter for letter. The fold follows the declaration, not the route, and
`backend/test/wire.test.ts` holds a field named for a currency to that schema. The backup is not
folded: it is not sent through `answer()`, and a restore has to put back what was stored.

**Answers that are not a screen's JSON are declared as such.** The CSV export, a stored statement
and the built client are `not-json`. The backup is `opaque-json`: JSON whose shape belongs to
`parseBackup`, which a client should be able to tell apart from "not JSON". A route missing from the
registry is a third state, and the router walk refuses it.

## How the declaration is held against the door

The checks below each cover what the others miss. They live in `backend/src/app.ts`, because they
need the `express` types this module may not import.

**The `answer` helper checks success replies by type.** The route key must be in the registry, the
body must have the declared type (with no extra fields in a fresh object literal), and the status
comes from the registry. It cannot see a driver returning a string for a `number`, an object built
in a `.map()` callback (inferred, not checked), or a route calling `json` directly.

**A wrapper over `json` and `send` checks every answer by value, under the suite only.** It is the
app's first middleware and does nothing unless a reporter is set under the `ANSWER_CHECK` app
setting. `backend/test/setup.ts` sets one and production never does, so production pays nothing. A
mismatch is recorded, not thrown: Express would turn a throw into `internal error`, with the reason
in a silenced log. For the same reason the check runs in a `try` and the original body is always
sent, so the test's own assertions see the real answer. The setup file drains the record after each
case and each file, so the case that caused a mismatch is the one that fails. The `send` half catches a JSON route
rewritten as `res.type('json').send(...)`. Not seen: `res.end`, `res.write`, and routes no test
calls.

**A walk over the router at import checks registration.** `assertAnswersDeclared` requires the
registered routes and the declared keys to match in both directions, and lists every mismatch. It
throws at import, so `npm start` fails before taking the lock, test files fail at collection, and so
does the CI job that starts the app. Routes are registered on `app` directly: a mounted router hides
its routes in its own stack, so the walk refuses one rather than recurse with a prefix it might
compose wrongly. A handler added with `use` has no route to key its answer by, so no declaration
could cover it, and the walk refuses every non-route layer except the door's named middlewares. An
anonymous or unknown one throws, naming itself; if Express renames its body parser or static server,
startup fails loudly. The answer check must be the first layer, compared by identity: it sees only
what comes after it, and a layer before it could answer unchecked.

## Invariants

**A count in a body is a number.** A `COUNT` from a raw `sql` template is a number on PGlite and a
string on PostgreSQL, and other aggregates can be strings on either. So `z.number()` over such a
figure can pass by default and fail only against a server, where the PostgreSQL suite catches it. Fix it with `Number()` where the value is read, never by
coercing or widening the schema.

**The client reaches this module by type only, through `web/src/types.ts`.** It takes the shapes and
unions, plus, type-only, the constants its own copies are pinned to with `typeof`: the chart
bounds, `CHART_ID_SHAPE_SOURCE` and `ERROR_DETAIL_MAX`. It also re-exports the goal bounds and
tuples and `SUPPORT_INCOME_SOURCE`, which only its tests read. With no value import there is nothing to bundle; `web/src/types.test.ts` refuses
a value import and a second door. The client's typecheck resolves `zod` from this package, so the
`web` job in `.github/workflows/ci.yml` and `npm run setup` install this package first.

**A calendar day is not a moment.** `CalendarDay` marks a day off a statement: a transaction's date
and value date, a recurring payment's last date, a statement's first and last day. Its first ten
characters are the YYYY-MM-DD the bank wrote. A transaction's date goes on with the time the file
stated, or UTC midnight when it stated none, so it looks like an instant and is not one: read as an
instant, it is the day before west of UTC, and a late-evening time is the next day east of it. A
client takes the day from those ten characters. On the server the brand comes from `calendarDay`,
which answers null unless the day exists and so does any time after it. An import and the insert of
transactions run it, and a statement with a date that does not exist is refused whole. A restore
checks the YYYY-MM-DD shape only, because a backup carries what an earlier version stored, and an
earlier version stored a day or a time that does not exist without checking it. So a date this
version imported is a real day and time. One it restored, or one an earlier version imported, starts
with YYYY-MM-DD but may name a day or a time that does not exist. One an earlier version restored
may have any shape, because that restore checked none. `Instant` marks a moment the app recorded,
which a client shows in the reader's own zone. Both brands are type-only and the JSON is a string
either way, so a client in another language has this paragraph and nothing else to go on.
