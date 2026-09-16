---
id: submodule-backend-test
type: submodule-design
status: draft
title: test — the backend suite, its harness, and the checks that read a file as text
parent: module-backend
---

What the backend suite is, where it reaches, and the rules about it that no type and no test holds.
`AGENTS.md`'s *Verification has a hole* carries what a green run does and does not cover — which
database it runs against, what jsdom cannot see, what skips on this platform — and the harness files
carry their own reasoning in their headers. Nothing below repeats them.

## Responsibility

- **The harness.** `backend/test/pglite.ts` is the database, embedded or real, and the truncate
  that stands in for isolation; `backend/test/setup.ts` is the shared environment, set
  before anything reads config, which is why the database modules there are dynamic imports.
  It is a vitest setup file, so it runs once per test file and truncates before each one — what
  the files share is the engine instance and the module registry, never the rows.
  `backend/test/helpers.ts` is the fixture layer. `backend/test/answers.ts` is the reporter the
  door records an answer mismatch into and the drain the setup file empties in its after hooks, so
  the case that produced the mismatch is the case that fails with it; the rule it holds is
  `backend/src/wire`'s. The drain runs in `afterAll` as well as `afterEach`, because an answer a
  file issues from its own `afterAll` has no case left to fail — and it needs the setup file's hook
  to run after the test file's own, which `sequence.hooks` pinned to `'stack'` in
  `backend/vitest.config.ts` is what provides.
- **The checks that read another file as text** instead of importing it. They exist where an
  invariant spans something no type can carry: a rule about the *shape* of code. A value that has
  to agree with one in the other package is no longer that kind of invariant: the client derives
  its wire types from `backend/src/wire` by type-only import and pins its runtime copies to the
  module's exports by type, so the pinned constants and the vocabularies meet in the client's `tsc`
  rather than in a file here that reads the client's source.
- **The coverage reading.** `npm run coverage` in either package runs its suite under the v8
  provider and prints a per-file table. The include is declared in `backend/vitest.config.ts` and
  `web/vitest.config.ts`: everything under `backend/src/` and `backend/scripts/` here, everything
  under `web/src/` less the test files and the harness in `web/src/test/` there — the harness is not
  product, and vitest excludes only the root setup files by itself, which the `dom` project's is
  not. The entry points, `backend/src/index.ts` and `web/src/main.tsx`, stay in and read nothing:
  they boot on import, so no case imports them — `backend/src/index.ts` is exercised by the `app`
  job in `.github/workflows/ci.yml`, `web/src/main.tsx` is built by it and runs only in a browser.
  It is a reading and not a gate: no threshold, and no CI step reads it.

## Boundary

A check here may read any file in the repository, and some do. Every one of them resolves its root
from `process.cwd()`, which is this package's root — locally, and in CI, where the backend jobs run
from this directory (`.github/workflows/ci.yml`). `web/src/copy.test.ts` resolves from
`import.meta.url` instead, and its own header states why: the root of its walk *is* the directory it
sits in, where a check here reads a target that is not beside it and so needs a package root. The
two idioms disagree on purpose; do not fix them into agreement.

The checks that read source as text: `backend/test/refusal-set.test.ts` reads the PDF importer and
requires every refusal it can throw to be composed where the budget case can measure it;
`backend/test/summary.test.ts` reads the data
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
`backend/test/specs.test.ts` reads every spec this repository declares — the documents at the root
and every `SPEC.md` — and every comment in every `.ts` and `.tsx` file `.gitignore` leaves in the tree — the config files beside the packages
included, and an untracked probe dropped under either package included — enumerated through
`commentsOf` in the comment tool's pure core rather than by a walk of its own or a scan of lines,
and refuses in a comment what it refuses in a spec: a path `.gitignore` keeps out of the tree, a
line citation, a commit sha, and any reference to the plan that carries no path — the plan's name, a
row, an item, a task id, a decision, finding, invariant, question, trap or stage number, a lettered
invariant, a section mark, a decision by letter, a settled item or a memo finding by its letter and
number, a pull request, a round of review or of fixing — because a reader who clones the repository
cannot open what those point at, while the same words inside a string literal or rendered as JSX
text are the product's and are not read; the price of the letter-and-digit family is that a hash
algorithm's or a cloud bucket's name spelled that way in a comment reds and is one word to rephrase,
which is the tie-break the file already states; a reference that names no number, one wrapped across
a line break in a `//` run or a starred block, a row of the plan written out in words, a row id
written with its stage letter and no padding, a bare hash sign and a number, *pull request* in words,
the pipeline's own vocabulary, *this row* in the plan's sense, a sha not in backticks, an absolute
path and an unpublished file named by its stem are not seen, and none is closed here; and the path
half is bounded by the extensions the citation clause reads, so a dotfile a reader creates for
themselves is unseen, rightly; it reads each spec's frontmatter under a grammar of its own — a line
is a key, a colon, one space and a value, or an inline list, and nothing else — because the tool
that indexes these files reads YAML whole, and a form that tool reads and this holder does not is a
field filled in and then trusted; it holds the identity a file declares to be one the literal
declares, the id unique, the type one of the durable ones, the status one of two, every parent a
declared spec and the parents one tree with the goal as its only root, and a link, where one is
written, resolving; a markdown file whose frontmatter carries an id and a type is a spec to that
tool whether or not anything here declares it, so the walk finds those and requires the set to
equal the literal; what it cannot see, stated: a spec under a directory `.gitignore` keeps out of
the tree, which the tool indexes and this holder does not, and a key written quoted, which the tool
reads and this grammar does not;
`backend/test/wire.test.ts` reads every source file under `backend/src/wire` and requires each to
name `zod` or a file inside that directory and nothing else — by import, re-export, `require`,
`import()`, `typeof import()` or triple-slash directive, anywhere in the tree — because the client's
own typecheck will compile that module and pull in whatever it imports;
`backend/test/check-stack.test.ts` reads the check stack's guards module and requires it to name
`node:path` and no other module and to run nothing at its top level, because a test that imported the
entry point beside it would spawn servers to reach one predicate;
`backend/test/comment-tokens.test.ts` reads the comment tool's pure core and its entry and requires
the core to name `typescript` alone and run nothing at its top level and the entry to be the
opposite of both, because a purity check that has only ever been shown a pure file cannot
demonstrate it can tell the two apart; and `web/src/copy.test.ts`, `web/src/tokens.test.ts` and
`web/src/types.test.ts` do the same thing from the other package, the second reading
`web/src/styles/tokens.css` for declarations and the whole package for the `var()` that reaches
them, because a custom property nothing names costs nothing at run time and so cannot be found any
other way, and the third reading every source file there for a specifier that reaches `backend/`,
requiring each to be the statement form `import type` or `export type` and `web/src/types.ts` to be
the only file carrying one, because a value import of the wire compiles, is erased by nothing and
bundles the module into the client with every suite green, and requiring every reference to browser
storage in the package's product files — its tests and its harness set aside — to sit in the two
files `web/src/SPEC.md` names and to be the operations it names for each, because *Platforms* says
no state lives only in the browser and the theme is its one deliberate exception. **Nothing holds
that list** —
a check added and not named here is named nowhere, which is the failure the hand-written lists below
describe in another module.

## Invariants

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
whose hand typed the line: an agent writing `active` is refused by nobody, so a status is
evidence only to the extent that the person reading it knows where it came from.
