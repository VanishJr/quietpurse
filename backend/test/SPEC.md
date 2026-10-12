---
id: submodule-backend-test
type: submodule-design
title: The backend suite, its harness, and the checks that read a file as text
parent: module-backend
---

## Responsibility

This directory is the backend suite: its harness, and the checks that read a file as text where a
rule about the shape of code has no other reader. What a green run covers, the database it runs on,
what skips and what the coverage reading is are in `AGENTS.md` under *Verification has a hole*.

**The harness.**

- `pglite.ts` opens and migrates its own database from `backend/drizzle`, embedded or real, not
  through `openDatabase`, and truncates every table
  `backend/src/db/schema.ts` exports, read at run time, so a new table is cleared without being
  listed.
- `setup.ts` sets the environment before anything reads config, so everything it loads from
  `backend/src`, directly or through a harness module, is a dynamic import.
- `answers.ts` records the answer mismatches the door reports, and the setup file drains them so the
  case that caused one fails with it. The rule it holds is `backend/src/wire`'s.
- `loopback.ts` is the only way a test reaches a server. It serves its target on a server of its own
  on `127.0.0.1` and returns a supertest agent. Handed an app, supertest listens on the unspecified
  address, which can be given a port another program holds on `127.0.0.1`, and the request then
  reaches that program. The setup file closes these servers in an `afterAll` that has to run after
  the file's own hooks, as the answer drain does, on the `sequence.hooks` order pinned in
  `backend/vitest.config.ts`. A closed server refuses to listen again, because supertest would
  otherwise listen again itself, on the unspecified address.
- `idle.ts` is the wait in the setup file's after hooks. `settleRecomputes` puts the offline `fetch`
  back, then waits for the recompute queue to go idle. The queue lives in the module registry the
  files share, and a run left in it would land in the next file's freshly truncated tables. Hence
  the rules for a case:
  - A `fetch` mock lives for one case. It goes in the case or in `beforeEach`, never in `beforeAll`
    or at file scope, where every case after the first runs offline whether or not anything notices.
  - A mock that parks a call rejects it when the request's signal aborts. One that ignores the
    signal never settles, and the wait then fails every later case in every later file.
  - A module instance imported after `vi.resetModules()` has a queue of its own, which the wait does
    not see.
  - The wait covers the runs queued before it returns, not after. A case that times out while its
    body waits on a held run can resume later and queue into the next case's tables, and no hook can
    stop it. So a hold case awaits nothing that settles only after a held run (the run's own
    promise, or a call queued behind it) until it has released that run, and it waits for a held run
    to reach a point only through `vi.waitFor`.
  - A refill the base-currency route starts is not on that queue, so nothing waits for it. A case
    that parks one releases it in its own `finally`.
- `helpers.ts` is the fixture layer.

**The checks that read a file as text**, listed below. A value that must agree with one in the
client is not their kind: the client derives its wire types from `backend/src/wire` by type-only
import and pins its runtime copies to the module's exports by type, so the two meet in the client's
`tsc`.

**What the coverage include means.** `backend/vitest.config.ts` includes `backend/src/` and
`backend/scripts/`; `web/vitest.config.ts` includes `web/src/` less its tests and its harness, and
says why. The entry points, `backend/src/index.ts` and `web/src/main.tsx`, stay in and read nothing:
they boot on import, so no case imports them. The `app` job in `.github/workflows/ci.yml` starts the
first and builds the second.

## Boundary

A check here may read any file in the repository, and some do. Each resolves its root from
`process.cwd()`, the package root both locally and in CI, where the backend jobs run from this
directory (`.github/workflows/ci.yml`). The web package's checks resolve from `import.meta.url`
instead, as `web/src/copy.test.ts` explains in its header: their root is the directory they sit in,
while a check here reads a target elsewhere and needs a package root. The difference is deliberate;
do not unify them. What the web checks hold is in `web/src/SPEC.md`, and for
`web/src/copy.test.ts` in that test's own header.

## The checks that read a file as text

Each reads its target as text because only the text shows the next file written the wrong way.
**Nothing holds this list:** a check added and not named here is named nowhere. Where a check's own
docblock gives its reason or its blind spots, they are not repeated here.

- **`refusal-set.test.ts`** requires every refusal `backend/src/providers/pdf.ts` throws to be named
  in `refusals()`, where the budget case measures it.
- **`summary.test.ts`** refuses a summary query in the data layer that writes the scoping helper's
  filters itself instead of calling the helper.
- **`http-body.test.ts`** reads `backend/src/app.ts` and holds every read of `req.body`, and every
  call to the JSON-body helper and its refusal arm, to the shapes its docblocks name. Those
  docblocks give the reasons and what its one token, `req.body`, cannot see; none of that is closed.
- **`loopback.test.ts`** keeps every request on a harness server. A request supertest builds from an
  app reaches whatever holds its port on `127.0.0.1`, and a test reaches supertest through any
  module it imports as well as by naming it.
  - In every script of the package outside `node_modules`, except `loopback.ts`, it refuses the name
    of supertest, of its types package or of a path inside either, as a quoted literal: the one
    spelling every import, re-export, `require`, `import()`, `typeof import()` and triple-slash form
    shares.
  - In every script under `backend/test/` and `backend/scripts/`, except `loopback.ts`, it refuses a
    call written `.listen(`.
  - It requires `loopback.ts` to be read by both readings and to carry both.
  - It refuses any file that vitest's default include collects outside `backend/test/`, and pins
    that default to the pattern it copies, because the suite runs such a file wherever it sits and
    the `.listen(` reading stops at those directories.
  - Not seen, and none closed: a specifier built at run time; a listen reached through an alias or a
    computed key; a listen outside those directories, `backend/src/` included; a listener in a child
    process; a test file collected only through an `include` in `backend/vitest.config.ts` or
    through a symlinked directory. A quoted name in a comment or a string that names no module is
    refused, which costs a word to rephrase and never a silence.
- **`specs.test.ts`** reads every declared spec (`ARCHITECTURE.md` and every `SPEC.md`) and every
  comment in every `.ts` and `.tsx` file `.gitignore` leaves in the tree, the config files beside
  the packages and untracked files included. Its docblocks give the reasons for its frontmatter
  grammar and its identity walk.
  - In specs and comments alike it refuses a path `.gitignore` keeps out of the tree, a line
    citation, a commit sha and a reference to planning notes outside the repository, by name or by
    number, because a reader of the clone cannot open them. It reads comments through `commentsOf`
    in the comment tool's pure core, so the words in a string literal or in JSX text, which are the
    product's, are never read. A hash algorithm's or a cloud bucket's letter-and-digit name in a
    comment fails too, and costs one word to rephrase.
  - Not seen by those clauses, and none closed: a reference that names no number; one wrapped across
    a line break in a `//` run or a starred block; a numbered reference written out in words; a task
    number with a letter after it and no leading zero; a bare hash sign and a number; *pull request*
    in words; a reference by position, such as *this row*; a sha not in backticks; an absolute path;
    an unpublished file named by its stem. A path is read only with an extension the citation clause
    knows, so a dotfile a reader creates for themselves is unseen, rightly.
  - Its identity walk reads wide, so a spec written and not declared is found and refused by name.
    What it cannot see: a spec under a directory `.gitignore` keeps out of the tree, and an identity
    in a form YAML reads and the walk's pattern does not.
- **`wire.test.ts`** requires every file under `backend/src/wire/` to import only `zod` or files in
  that directory, and counts the object schemas declared there so the strictness walk cannot skip
  one.
- **`comment-tokens.test.ts`** requires the comment tool's core,
  `backend/scripts/comment-tokens.ts`, to import `typescript` alone and run nothing at its top
  level, and its entry, `backend/scripts/comment-check.ts`, to be the opposite of both.
- **`initial-migration.test.ts`** reads `backend/drizzle/` and its journal and requires a single
  initial migration and snapshot, the pre-release rule in `AGENTS.md`.
- **`currency.test.ts`** reads every script in `backend/src` outside `backend/src/providers/`,
  except `backend/src/currency.ts`, with its comments taken out, and refuses a line that compares or
  groups a currency without the shared fold: `sameCurrency`, `currencyKey` or `CURRENCY_KEY`.

## Invariants

**A green default run does not prove a raw `sql` aggregate is read correctly.** PGlite returns a
`COUNT` as a number and node-postgres returns it as a string, so an aggregate without `Number()`
around it is green locally and red only in the CI job that sets `TEST_DATABASE_URL`. A change that
adds one is run against a real Postgres before it is believed. The default run uses the product's
own engine, so what it proves holds for the product; the Postgres job keeps the connection-string
path honest.

**`typescript` is declared in `backend/package.json` for the typecheck, and is also a library
here.** Several tests and the comment tool in `backend/scripts/` import its compiler API, on
purpose: an invariant about the shape of source has no other reader.
