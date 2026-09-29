# Finto

A personal finance tracker that runs on one person's own machine. They upload bank statements
in whatever format they happen to have, and get their financial data organised and readable.
No account, no server: the database and the statements are files in one folder on their disk.

**The import promise: one upload button.** CSV, XLSX, PDF — the user should never have to know or
care which parser runs.

**Platforms.** The web client is the product being built now. Native iOS and Android come later,
which is why the REST API — not the React app — is the real contract: no logic that a mobile
client cannot reach, no state that lives only in the browser.

## What is in this file, and what is not

This is the durable half: layout, commands, the invariants, and the shape of what the test suite
cannot see. It is the file to read before changing anything.

Two things it deliberately does not carry. **Counts** — how many tests, which tip they were
measured on — live in a working file outside the repository, because a number published here is
wrong by the next merge. And **the work** — what the owner asked for, and the findings that did
not become a task — is not in the public tree either: a task starts from the owner's words in
chat, and its record under `.agents/tasks/` and `DEBT.md` are per-machine files that
`.agents/README.md` describes and you are not missing. Nothing here depends on them.

## Layout

```
backend/    Express 5 + TypeScript, Drizzle ORM over Postgres (PGlite in the process, or a server), Zod, pino
  src/db/       the schema, every query, and the one function that opens the database
  src/providers/ the one ingestion surface and the per-format parsers behind it
  src/wire/     every route's answer declared once; the backend's types are inferred from it
  drizzle/      generated migrations
  test/         vitest + pglite + supertest; helpers.ts and pglite.ts are the harness
web/        React 19 + Vite + Recharts
  src/screens/  Overview, Transactions, Analytics, Goals, Settings
package.json  the two commands a person runs: setup, start
```

`.agents/README.md` is how a task is run — the pipeline, and which checks are worth trusting.
`ARCHITECTURE.md` is the module map and the path one statement takes through it. `SECURITY.md` is
the threat model.

## Commands

From the repository root, the two a person runs:

```
npm run setup         installs both packages and builds the client into web/dist
npm start             serves the app on http://localhost:4000, data under ~/Finto
```

From `backend/` unless stated otherwise:

```
npm run typecheck     tsc --noEmit          both packages; backend runs it twice
npm test              vitest run            both packages have this
npm run coverage      vitest run --coverage the suite plus a per-file reading; not a gate
npm run dev           tsx watch src/index.ts
npm run db:generate   drizzle-kit generate
npm run check:comments tsx scripts/comment-check.ts  compare|count: whether a change is comment-only, and how much is comment
cd web && npm run dev
cd web && npm run coverage                    the same reading for the client
```

Verification means both `npm run typecheck` and `npm test` green in `backend/`. A change is not
finished on a claim that they pass — run them.

`typecheck` is two `tsc` runs and reaches every `.ts` file in `backend/` outside `node_modules`.
`tsconfig.json` takes `src`, `scripts` and the root config files as CommonJS, which is what `tsx`
runs them as; `tsconfig.test.json` takes `test/` as ESM, which is what vitest runs it as.
`tsconfig.json` is deny-by-default (an `exclude`, no `include`), so a directory added later is
checked by it without anybody remembering. `tsconfig.test.json` names `test/` explicitly, so a test
directory created outside `test/` is checked as CommonJS by the base config — a red, not a silent
gap. vitest still strips types without checking them, so a green suite is not a type check — but a
change confined to test files is no longer verified by the suite alone.

**Bare `npx tsc --noEmit` is weaker than `npm run typecheck`**: it reads `tsconfig.json` only and
never sees `test/`. Nothing can force the second invocation; the script is what holds it, and CI
runs the script. **And run it from `backend/`, or through `npm --prefix backend`**: the repository
root now has a `package.json` with no dependencies, so an `npx tsc` or `npx tsx` typed there finds
no local binary and pulls whatever the npm cache holds under that name — an unrelated package in
the case of `tsc`, an unpinned version in the case of `tsx`.

## Invariants

- **One person, one folder, one process.** Everything the app keeps is under `FINTO_HOME`
  (`~/Finto` by default): the embedded database in `db/`, the uploaded statements in
  `statements/`, and a lock file holding the running process's pid. PGlite does not refuse a
  second opener, so the lock is the only thing between two `npm start`s and a corrupted
  database; `src/lock.ts` claims it, `src/index.ts` calls the claim before opening anything, and
  it refuses while a live pid holds it.
- **No sign-in, so the port is the boundary.** Whoever can reach the port owns the data behind
  it. The server binds the loopback interface unless `FINTO_HOST` says otherwise, and nothing in a
  route asks who is calling. A feature that needs to know who is acting has nowhere to read it
  from; do not add one that pretends to.
- **Transaction identity.** `transactions.id` is a surrogate UUID; deduplication runs off a
  separate computed key with a per-group ordinal (`src/db/dedup.ts`). Ordinals stay dense across
  a delete. Do not conflate the two keys.
- **Import provenance.** Every transaction carries `import_id`. `imports` is uniquely indexed on
  `file_hash WHERE status = 'committed'` — only `committed` means the rows are actually in the
  database, so only `committed` may block a re-upload.
- **A stored statement is the uploaded file, plain, under a name derived from its row.** The
  name is a function of the import id, the uploaded filename and the recognised format, and it is
  derived again at every read and delete rather than stored — a stored name is a path a crafted
  backup gets to choose. So those three fields are written once and updated by nothing, and a
  delete carries all three. The reduction of the filename, and why `CON.txt` is the shape to
  worry about, is in `src/SPEC.md`.
- **Migrations stay squashed until the first release.** There are no released databases to upgrade,
  so `backend/drizzle/` carries one initial migration and one matching snapshot. Before release, a
  schema change is regenerated into that migration rather than appended as another file. The first
  release ends this policy: from then on, applied migrations become immutable and every change gets
  the next migration.
- **Categories are slugs** in the database and over the API; display names live in the client
  dictionary. The slug is a stable contract.
- **Goals survive missing accounts.** A goal-to-account row deliberately has no account foreign
  key. Deleting an account leaves the saved goal visible with an actionable unavailable status;
  it never cascades the goal or silently retargets it.
- **Nothing is required to start.** Every setting has a default that works on a machine with
  nothing installed; `.env` holds process settings and no secrets, because there are none.
  Everything a person edits lives in the `settings` table.
- **A diagnostic is not delivered until it survives every cap between composition and screen.**
  `ERROR_DETAIL_MAX` bounds what reaches `imports.error_detail`, and `web/src/api.ts` shows that
  whole budget — its `MAX_ERROR_CHARS` is pinned to `ERROR_DETAIL_MAX` by type, so the two cannot
  differ. So ordering decides which clause is *dropped*, not which is read: compose actionable
  text first and let refinements yield, and include an appended clause whole or not at all —
  never cut mid-token, since a truncated tail names things that do not exist. Before trusting
  the number, read it; it has moved once already.
- **Silent success is the failure mode that matters.** A crash is recoverable; a 200 answer on
  data the user did not upload, or a partial import reported as complete, is not. Where a choice
  is between refusing loudly and proceeding quietly, refuse.

## Verification has a hole

`web/` runs two vitest projects, split by filename so the environment cannot be got wrong: `unit`
(`src/**/*.test.ts`, node, no DOM — formatting, the slug dictionaries, how a failed request becomes
a sentence) and `dom` (`src/**/*.test.tsx`, jsdom + React Testing Library). Any request to a route
the test did not declare fails that test.

What jsdom cannot see is a limit of the environment, not a gap waiting to be filled: no layout and
nothing from `styles.css`, so the only visibility fact available is the `hidden` attribute; no real
navigation and no download, so whether a file lands on disk is unanswerable here; no chart
rendering — recharts measures a 0×0 box, so a test can mount a donut and assert nothing about it.
Those checks stay manual, and an agent can run them: a real Chrome is reachable through the
`claude-in-chrome` tools, and each check is recorded with how it was observed (`.agents/README.md`,
and rule 9 in `.claude/agents/reviewer.md`). The carve-out is Settings' **`Export backup`**, which
stays the maintainer's — it writes every transaction to a file, and that is not an export an agent
runs on anyone's behalf.

Several screens and both shared controls are mounted by a test and asserted about by nothing:
mounting is not coverage, and `Sheet`'s and `Chips`' own behaviour — the backdrop, Escape, focus,
`aria-pressed` — is nowhere. Each stays unverified until someone clicks through it, and **an
unrecorded click leaves it unverified too**, because nothing downstream can tell that run from one
that never happened. Say which screens a green run covered rather than implying it covered `web/`.

The backend suite runs on an embedded PGlite in memory by default — the same engine the product
runs on — and on a real Postgres when `TEST_DATABASE_URL` is set (CI does both). PGlite is
single-connection, so nothing about concurrency — a unique index losing a race, two writers meeting
— is exercised by the default run. The suite truncates every table in the database it is given
and refuses one not named `*_test`. It runs in one process, and `test/setup.ts` is a vitest setup
file, so it runs once **per test file**: it truncates every table and then seeds the defaults, before
each one — measured, three files, three runs. What is shared between files is the PGlite instance and
the module registry, not the rows. A file whose figures are exact repeats that pair in its own
`beforeAll` anyway, because its exactness then rests on a line in the file rather than on a setup
file the file does not name.

`npm run coverage` in either package prints a per-file reading of what the suite reached —
`src/**` and `scripts/**` in `backend/`, `src/**` less the test files and the harness in `web/` —
with the entry points (`src/index.ts`, `src/main.tsx`) left in and reading nothing, because they
boot on import, so no case imports them — `backend/src/index.ts` is exercised by the `app` job in
CI, `web/src/main.tsx` is built by it and runs only in a browser. It is a reading and not a gate:
no threshold, and no CI step reads it.

One backend test never runs on Windows or as root: `test/documents.test.ts` skips there, so a green
local run on either is one short of the total. It is the boot check that a statements folder which
exists but cannot be written to is refused, and CI (ubuntu, non-root) is the only place it fires.
Nothing else skips — `canvasabsent.test.ts` hides the package in a spawned child and runs
everywhere.

## Conventions

- **A module's code carries almost no comments; the reasoning behind it lives in that module's
  `SPEC.md`.** This is a change of destination and not a licence to delete — what the keep list
  below protects is exactly what a spec is for. **The test is where the edit that would break the
  reason is made.** A reason an edit to its own line would break stays beside it: a sentinel's
  meaning, a sign or rounding convention, why a clause is absent from this expression, a rejected
  alternative a reader will re-attempt here, an ordering the shape of this function enforces —
  however far the coupling that ordering serves reaches. A reason broken by an edit made in
  another file, by somebody who will never open this one, goes to the spec: a coupling read from
  another file, an ownership boundary, a rejected design at module scale, what a future producer
  owes. A comment cannot reach them and a spec can.
  - **A derivation whose content is its arithmetic stays in code, whole, beside the constant it
    bounds.** A spec is bound by the delete-on-sight list, so it cannot carry the figures; and a
    chain split across two documents is how three files each came to hold a locally checkable part
    of one with nobody owning the sum, and both premises of one part were false while its number
    stayed right. The spec says such a chain exists, where it is written whole, and what it
    crosses.
- **A spec is a markdown file whose frontmatter carries an `id` and a `type`, and that
  frontmatter is the one copy of its title and its status.** The two root documents are
  `goal-and-requirements.md` and `ARCHITECTURE.md`; every other spec sits beside its module as
  `SPEC.md` and names its parent by id. The fields are `id`, `type`, `status`, `title`, `parent`,
  and — only where the code shows the edge — `depends-on`, `references`, `implements`; a line is
  `key: value` or `key: [a, b]` and nothing else. A status is `draft` or `active`: a new or edited
  spec is `draft` until the owner has read it, and the flip is the owner's. A module spec opens
  with `## Responsibility` and carries `## Boundary` and `## Invariants` for the rules no type and
  no test holds; its topical sections are its own, and the root documents keep theirs. A spec
  carries no line citation, no commit sha, no reference to the plan and no path a reader of the
  public tree cannot open — `backend/test/specs.test.ts` refuses each, refuses a frontmatter
  written in any other form, and holds the parents to one tree. It carries no count either, and
  that one is held by review.
- **A comment may not state a fact that something else could check.** Nothing tests prose, so a
  comment carrying a number, a count, a measurement, a reachability claim or an inventory of what
  exists is believed long after it stopped being true — comments in this tree have been found
  measurably false, and in the densest files they outweighed the code. If the fact is worth
  holding, **assert it in a test and let the comment name the reason instead**: the refusal bound
  in `pdf.test.ts` survived every rewrite around it because an assertion sits beside the sentence,
  where `csv.ts`'s "nothing reads it yet" was false the moment something read it and nothing said
  so.
  - **Delete** on sight: a number, count, date, percentage, byte size, line number or file
    inventory; a row number, task id, review round or decision reference; what a test does, what
    a fixture holds, what a past run produced; anything the line below already says; a section
    banner or divider.
  - **Keep** beside the code only what cannot be recovered by reading the code, *and* would break
    behaviour if got wrong, *and* is broken by an edit to the line it sits on: **why something is
    ABSENT** — a missing clause, filter or check that looks like an oversight and is deliberate,
    which is the most valuable kind here because absence has no syntax; which of two compiling
    readings is the intended one; a rejected alternative a reader will otherwise re-attempt,
    stating the reason and not the story; an ordering or coupling constraint between distant parts
    of the code; a unit, sign or rounding convention the type does not carry.
  - There should be **far fewer keeps than feels right**, and the bar is the test, not a count: a
    loud failure does not justify a comment — the breakage has to be *silent* — and the edit that
    would cause it has to be an edit to that line. A file whose keeps are a data literal measured
    off a document no reader can open is where a long keep list is the honest answer. Where a
    comment mixes a kept reason with a checkable claim, rewrite it to the reason alone; do not
    keep the number "for context".
  - `COMPUTED_PREFIX`'s docblock in `src/db/dedup.ts` is the shape to copy.
- Match the style, naming and idiom of the file being edited — **but never its comment volume.**
  Matching a dense neighbour is how the density spread.
- **Never commit, push, or `git add` without being asked.** Work is left in the working tree; the
  human commits. The task pipeline is the one standing request: its commands commit every round
  on the task's branch, per `.agents/concepts/commits.md`, and no agent inside it commits.
