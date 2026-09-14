# backend/src/wire

Status: draft

What this module owns, what it may depend on, and the rules about the API's answers that no type
and no test holds. `backend/src/SPEC.md` answers for the door the requests come through — the
request schemas, the refusal sentences, the status split — and stops here; this document answers
for what goes *out*.

## What this module owns

**The declared answer of every route.** Every 2xx JSON body the API gives is declared once, here,
as a zod schema, and `ANSWERS` keys each declaration by the method and the path exactly as Express
registers the route. The refusal envelope — `{ error }` with a sentence in it — is a declared shape
too, and the one refusal that carries more than a sentence, the charts route's stale 409 with the
current version and list inside it, is declared as its own shape beside the route it belongs to.

**The backend's own type for every one of those shapes is the declaration's inference.** There is
no hand-written wire shape anywhere else in `backend/src`: `backend/src/types.ts`, the data layer,
the ingestion surface, the settings modules and the independence computation re-export their names
from here. A module may narrow a wire shape — by `Omit`, `Exclude`, `Extract` or a compile-time
brand — or re-compose one from the wire's own pieces, and put on the derivation what the wire does
not carry: `NewTransaction` in `backend/src/types.ts` omits from `Transaction` the id and every
field the data layer assigns after insert, so a parser states what a statement states and nothing
else, and adds the key a format's own stable reference to an operation plugs into; the ingestion
surface's `ImportSummary` puts a brand on the two fields only its reconciliation may fill, over the
wire's own `totals` and `balances` types. What a module may not do is write a wire shape's fields
out again on its own: a type for a wire shape that no type operator ties back to the declaration
is a second declaration, and a declaration that exists twice agrees with the route by luck.

**The vocabularies and bounds the client composes against.** The chart kinds, ranges, breakdowns
and measures, the chart length bounds, the id charset — as a string source beside the
`RegExp` built from it, because a type can carry the string and not the pattern — the import
source types and statuses, the income-source kinds, the goal modes, the reasons a balance pair is
not shown, and the diagnostic budget `ERROR_DETAIL_MAX`. `backend/src/db` imports the tuples for
its column options and its check constraints and never the reverse; the request schemas in
`backend/src/app.ts` compose over the same tuples with their own refusal sentences and never meet
the answer schemas.

## Where the boundary runs

**This module imports zod and its own files, and nothing else.** No node builtin, no `express`,
no `drizzle-orm`, nothing from `backend/src/db` or `backend/src/providers` — not even as a type.
The client's own typecheck will compile this file, and it pulls in whatever the file imports: a
data-layer type reached through the schema module would drag the whole of `drizzle-orm` into the
client's program. That is why the vocabularies moved *into* this module and the data layer imports
them back. Held by `backend/test/wire.test.ts`, which walks every import, re-export, `require`,
`import()`, `typeof import()` and triple-slash directive in the module's source over the whole tree
and refuses any specifier that is not `zod` or a relative path inside this directory.

**The file is compiled by two compilers, and the second is the client's.** `web/src/types.ts`
re-exports this module's types, so the client's `tsc` — `ESNext` modules, `bundler` resolution,
`isolatedModules`, `noUnusedLocals`, `noUnusedParameters` — compiles this file beside this package's
own `commonjs` one. An edit only the client's refuses — a `const enum`, an `export =`, a type
re-export without `export type`, an unused local — is green in both backend jobs and red in the
`web` job, and that coupling is what holds the file to ESM-style imports, `export type` on every
type-only re-export, no `require` and no `__dirname`; the specifier walk holds the half about what
the file names.

## What a declaration says, and how it is read

**Every object on the wire is strict.** A plain `z.object` strips the keys it does not know and
would certify a body it never saw; a strict one turns an undeclared field into a parse failure.
`backend/test/wire.test.ts` walks every declared body through its arrays, unions, optionals,
nullables and readonly wrappers and refuses an object node whose catchall is not `never`, and it
counts the nodes it visited so a walk that found nothing reds rather than passing over an empty
set.

**Optionality is what the producer emits, found by reading the mapper.** A field the row mapper
sets on every row is required, whatever the old hand-written type said; a field a producer omits is
optional. Absence and `null` are different answers and are declared apart: a base-currency amount is
absent while no rate has been fetched, never null; a fee is absent on the way out and null on the
way in, and `NewTransaction` is where the null lives; the manual transfer flag is null when the user
has not decided and is present on every row. A list of an account's foreign currencies is required
rather than optional because empty means *checked, and there are none* where absent means nobody
looked. A flag that is only ever `true` on the wire — a delete, a discard, a restore, the health
answer — is declared as the literal, because that is what the route emits; the client may read it as
a boolean and lose nothing.

**A value a screen renders as prose crosses as a slug.** The reasons a balance pair is not shown
are a closed vocabulary here and a sentence in the client's dictionary, which is this codebase's own
idiom for a value a screen renders as prose; the same holds for a category and an income-source id.

**A route that answers something other than a screen's JSON says so.** The CSV export, the stored
statement's bytes and the built client are declared `not-json`; the backup is declared
`opaque-json`, because its body is JSON whose shape belongs to the restore route that reads it, and
"not JSON" and "JSON whose shape lives with `parseBackup`" are different facts a client should be
able to read apart. A key absent from the registry is a third state, and the walk below refuses it.

## How the declaration is held against the door

The holds below each cover what the others cannot see, and all of them live in `backend/src/app.ts`,
because the door owns what crosses it and they need the `express` types this module may not import.

**A typed reply helper at every success site holds production, by type.** `answer` takes the route
key as a literal, so a key the registry does not carry is a compile error; it takes the body as the
declaration's inferred type, so a route whose body is not its declared shape is a compile error, and
where the body is a fresh object literal an undeclared field is one too; and it reads the status off
the registry, so a route cannot answer the wrong status by accident. What it cannot see: a value
whose type says `number` while the driver hands over a string, an object built inside a `.map()`
callback, which is inferred rather than checked, and a route that reaches for the response's own `json` method directly.

**A wrapper over the response's `json` and `send` methods holds the wire under the suite, by value.** It is the
first middleware on the app and is inert until something puts a reporter under the app setting
`ANSWER_CHECK` names — `backend/test/setup.ts` does, and nothing in production does, so a production
answer pays nothing and a foreign settings row restored from another version does not become a 500
on the settings route. Under the suite every JSON answer is parsed in its serialised form, never the
in-memory object, because an undefined property and a `Date` are different things before and after
the wire; a mismatch is recorded with the route, the status and every zod issue path, and the setup
file drains that record in `afterEach` and in `afterAll`, so the case that produced the mismatch is
the case that fails with it, and an answer issued from a file's own `afterAll` is not lost when the
next file installs a fresh reporter. Recorded and never thrown from inside the `json` method: a throw there
is caught by Express and answered as `internal error`, with the reason in a silenced log. The
wrapper's own work sits inside a `try` for the same reason, and the original is still called with the
original body whatever the check found — the case's own assertions see the true answer. The `res.send`
half exists for one line: a declared JSON route edited to answer `res.type('json').send(...)` would
otherwise be green with an unparsed body. Anything sent through `send` on a `json` route with a
success status and no `json` call behind it is recorded as such; a route writing to the socket
through `res.end` or `res.write` directly is the residual nothing here sees. What the wrapper cannot
see: a route the suite never hits.

**A walk over the router at import holds registration.** After the last route is registered,
`assertAnswersDeclared` reads every route off the app's router and requires the set of keys to equal
the registry's, in both directions — a route with no declaration and a declaration with no route are
each listed by key in the throw. It throws at import, so `npm start` dies before the lock is taken,
every test file that imports the app reds at collection, and the CI job that starts the real process
reds too. Routes are registered on `app` directly so the declaration walk can see them: a router
mounted under a prefix carries its routes inside its own stack, where both directions of the
equality would pass over a route nobody declared, so the walk refuses a mounted router outright
rather than recursing with a prefix it could compose wrongly. A handler mounted with `use` rather
than registered as a route is the sibling form: it answers with no route for the wrapper to key its
body by, so no declaration could ever cover it, and both directions of the equality pass over it
too. The walk therefore refuses every non-route layer it does not recognise, and it recognises by
function name against the door's own middlewares — the answer check, the response headers and
request log, the origin check, the JSON body parser, the static file server and the error handler —
so the app's non-route layers are those and nothing else, and an anonymous handler or a foreign one
throws at import naming itself. A rename inside Express of one of the two it does not own reds the
boot loud rather than letting anything through. Of the layers it recognises, the answer check is
required to be the router's first, by identity and not by name — a reorder that puts any layer
ahead of it, or a deletion of it, reds at import wherever the app is imported, because the wrapper
sees only what sits behind it, and a layer ahead of it that answers, answers unparsed.

## The invariants no type and no test holds

**A count in a body is a number.** The embedded engine answers an aggregate as a number and a
PostgreSQL server answers it as a string, so a `z.number()` over a figure that comes out of a raw
`sql` template is green on the default run and red only against the server. The suite against a real
server is what holds it; the fix is `Number()` in the route, never a coerced or widened schema.

**A relocated docblock is a claim.** The reasoning on a schema field here came from the hand-written
types it replaced, and each sentence was read against the mapper or the query it describes when it
landed. The next move re-reads them; age is not evidence.

**What the client builds on.** The client reaches this module by type only and through one door,
`web/src/types.ts`: the shapes and the union types under this module's own names — the chart
vocabularies' and the goal modes' among them, which its picker records are keyed by — and `typeof`
of the six constants its runtime copies are pinned to: the four chart bounds, the id charset's
string source and `ERROR_DETAIL_MAX`. It never names the tuples and imports no value, so it carries
no runtime dependency it would have to bundle;
`web/src/types.test.ts` refuses a value import and a second door. Its typecheck resolves `zod`
through this package's dependencies, so the `web` job in `.github/workflows/ci.yml` installs this
package's dependencies before its own, and `npm run setup` installs this package first.
