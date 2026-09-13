# backend/test

Status: reviewed

What the backend suite is, where it reaches, and the rules about it that no type and no test holds.
`AGENTS.md`'s *Verification has a hole* carries what a green run does and does not cover — which
database it runs against, what jsdom cannot see, what skips on this platform — and the harness files
carry their own reasoning in their headers. Nothing below repeats them.

## What this module owns

- **The harness.** `backend/test/pglite.ts` is the database, embedded or real, and the truncate
  that stands in for isolation; `backend/test/setup.ts` is the shared environment, set
  before anything reads config, which is why the database modules there are dynamic imports.
  It is a vitest setup file, so it runs once per test file and truncates before each one — what
  the files share is the engine instance and the module registry, never the rows.
  `backend/test/helpers.ts` is the fixture layer.
- **The checks that read another file as text** instead of importing it. They exist where an
  invariant spans something no type can carry: a rule about the *shape* of code, or a value that has
  to agree with one in a package that shares no build with this one.

## Where the boundary runs

A check here may read any file in the repository, and some do. Every one of them resolves its root
from `process.cwd()`, which is this package's root — locally, and in CI, where the backend jobs run
from this directory (`.github/workflows/ci.yml`). `web/src/copy.test.ts` resolves from
`import.meta.url` instead, and its own header states why: the root of its walk *is* the directory it
sits in, where a check here reads a target that is not beside it and so needs a package root. The
two idioms disagree on purpose; do not fix them into agreement.

The checks that read source as text: `backend/test/refusal-set.test.ts` reads the PDF importer and
requires every refusal it can throw to be composed where the budget case can measure it;
`backend/test/error-budget.test.ts` reads the client's own cap, because the packages share no build
and that file is the only place the two numbers meet; `backend/test/charts-door.test.ts` reads the
client's chart model for the same reason and holds it EQUAL to the charts route's four vocabularies,
four length bounds and id charset rather than merely within them, because the route refuses a whole
list and a client narrower than the door substitutes a chart the reader did not ask for while one
wider than it composes a list nobody can save; `backend/test/summary.test.ts` reads the data
layer's summary block and refuses a further summary query written with the scoping helper's filters
rather than through it; `backend/test/http-body.test.ts` reads the HTTP door and refuses a route
that reads `req.body` by any shape but the four it names — a zod parse, the JSON-body helper's own
read into `unknown`, the restore route's read into `unknown`, and the upload route's read of what
multer populated — refuses a call to that helper that is not a binding followed by its return, and
refuses the helper's own refusal arm unless its next line is `return undefined;`, because a bare
read of a body no parser claimed is a `TypeError` answered as the server's fault, a helper call
whose result is defaulted lands a write behind a refusal, a helper that answers the refusal and
hands an object back leaves every route's return dead, and only the file's text can see the next
route written any of those ways; the shape rule's one instrument is the token `req.body`; a
spelling that does not carry that token — a renamed request parameter, `const { body } = req`,
`req['body']`, an alias — and a line whose read sits after a `//` inside a string are not seen,
and none is closed here;
`backend/test/specs.test.ts` reads every `SPEC.md` this repository declares;
`backend/test/check-stack.test.ts` reads the check stack's guards module and requires it to name
`node:path` and no other module and to run nothing at its top level, because a test that imported the
entry point beside it would spawn servers to reach one predicate;
`backend/test/comment-tokens.test.ts` reads the comment tool's pure core and its entry and requires
the core to name `typescript` alone and run nothing at its top level and the entry to be the
opposite of both, because a purity check that has only ever been shown a pure file cannot
demonstrate it can tell the two apart; and `web/src/copy.test.ts` and
`web/src/tokens.test.ts` do the same thing from the other package, the second reading
`web/src/styles/tokens.css` for declarations and the whole package for the `var()` that reaches
them, because a custom property nothing names costs nothing at run time and so cannot be found any
other way. **Nothing holds that list** —
a check added and not named here is named nowhere, which is the failure the hand-written lists below
describe in another module.

## The invariants no type and no test holds

**A green default run does not prove a raw `sql` aggregate is read correctly.** PGlite answers a
`COUNT` as a number and node-postgres answers it as a string, so an aggregate that reaches a caller
without `Number()` around it is green on every local run and red only in the CI job that sets
`TEST_DATABASE_URL`. A change that adds a raw `sql` aggregate is run against a real Postgres before
it is believed. The default run is on the engine the product itself uses now, so what it proves
about the embedded database it proves about the product; the PostgreSQL job is what keeps the
connection-string path honest.

**`typescript` is declared in `backend/package.json` for the typecheck script, and a test in this
directory also imports its compiler API as a library.** That import is deliberate rather than a
transitive accident: an invariant about the *shape* of source has no other reader.

**The lists that are kept equal to the schema by reading** live partly in this directory, and they
are named and explained once, in `backend/src/db/SPEC.md`, rather than twice.

**`backend/test/specs.test.ts` holds that a spec declares one of two statuses, and holds nothing
about which one is true.** The flip out of draft follows the owner's review, and no check can tell
whose hand typed the line: an agent writing the reviewed value is refused by nobody, so a status is
evidence only to the extent that the person reading it knows where it came from.
