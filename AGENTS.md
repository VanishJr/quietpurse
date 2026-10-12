# Quietpurse

A personal finance tracker that runs on one person's own machine. They upload bank statements in
whatever format they have and get their finances organised and readable. No account, no server: the
database and the statements are files in one folder on their disk.

**The import promise: one upload button.** CSV, XLSX or PDF, the user never has to know which parser
runs.

**Platforms.** The web client is the product being built now; native iOS and Android come later. So
the REST API, not the React app, is the contract: no logic a mobile client cannot reach, no state that
lives only in the browser.

## About this file

The rules that last: layout, commands, invariants, and what the tests cannot see. Read it before
changing anything, whether you are a person or an agent. `CONTRIBUTING.md` is the short version.

It carries no counts, such as how many tests there are: a number written here is wrong by the next
merge.

## Layout

```
backend/    Express 5 + TypeScript, Drizzle ORM over Postgres (PGlite in the process, or a server), Zod, pino
  src/db/       the schema, every query, and the one function that opens the database
  src/providers/ the one ingestion surface and the per-format parsers behind it
  src/wire/     every route's answer declared once; the backend's types are inferred from it
  drizzle/      generated migrations
  test/         vitest + pglite + supertest; every file not named *.test.ts is harness or fixture
web/        React 19 + Vite + Recharts
  src/screens/  Overview, Transactions, Analytics, Goals, Settings
package.json  setup and start, plus typecheck and test for both packages
```

`ARCHITECTURE.md` is the module map, `SECURITY.md` the threat model.

## Commands

```
npm run setup         installs both packages and builds the client into web/dist
npm start             serves the app on http://localhost:4000, data under ~/Quietpurse
npm run typecheck     both packages
npm test              both packages
```

In `backend/`:

```
npm run typecheck     tsc --noEmit, then tsc -p tsconfig.test.json
npm test              vitest run
npm run coverage      the suite plus a per-file reading; not a gate
npm run dev           tsx watch src/index.ts
npm run db:generate   drizzle-kit generate
npm run check:comments compare|count: whether a change is comment-only, and how much is comment
```

In `web/`: `npm run typecheck`, `npm test`, `npm run dev`, `npm run coverage`.

**A change is verified when `npm run typecheck` and `npm test` pass in both packages,** as in CI and
`CONTRIBUTING.md`. Run them: a claim that they pass is not enough.

**The backend typecheck is two `tsc` runs** that together reach every `.ts` file in `backend/`
outside `node_modules`: `tsconfig.json` takes `src`, `scripts` and the root config files as CommonJS,
like `tsx`, and `tsconfig.test.json` takes `test/` as ESM, like vitest. Why each config is shaped as
it is sits in the config. vitest does not check types, so a change to test files alone still needs
the typecheck.

**Use the script, not bare `npx tsc --noEmit`,** which never sees `test/`; CI runs the script. **Run
`tsc` and `tsx` from `backend/`** or through `npm --prefix backend`: the root `package.json` has no
dependencies, so `npx tsc` there pulls an unrelated package from the npm cache, and `npx tsx` an
unpinned version.

## Invariants

- **One person, one folder, one process.** By default everything the app keeps is under
  `QUIETPURSE_HOME` (`~/Quietpurse`): the database in `db/`, the uploaded statements in
  `statements/`, and a lock file with the running process's pid. `DATABASE_URL` and
  `DOCUMENT_STORE_PATH` can move the database and the statements. PGlite does not refuse a second
  opener, so the lock is all that stops two `npm start`s from corrupting it: `src/index.ts` calls
  `src/lock.ts` before opening anything, and a live pid in the lock refuses the start. With
  `DATABASE_URL` the server locks for itself and no lock file is written.
- **No sign-in, so the port is the boundary.** Whoever reaches the port owns the data. The server
  binds the loopback interface unless `QUIETPURSE_HOST` says otherwise, and no route asks who is
  calling. Do not add a feature that needs to know who is acting: there is nowhere to read it from.
- **Transaction identity.** `transactions.id` is a surrogate UUID. Deduplication uses a separate key
  computed from the row's content (`src/db/dedup.ts`), with a per-group ordinal so that a statement
  listing the same charge twice keeps both. Ordinals stay dense across a delete. Conflating the two
  keys brings duplicate imports back.
- **Import provenance.** Every transaction the app inserts carries `import_id`. The column is
  nullable only for rows no import owns, which a restored backup can carry. `imports` is uniquely
  indexed on `file_hash WHERE status = 'committed'`: only `committed` means the rows are in the
  database, so only `committed` may block a re-upload.
- **A stored statement is the uploaded file, plain, named after its row.** The name is derived from
  the import id, the uploaded filename and the recognised format at every read and delete, never
  stored: a stored name is a path a crafted backup could choose. So those three fields are written
  once and never updated, and a delete carries all three. `src/SPEC.md` explains the filename
  reduction, and why a Windows device name before a dot (`con.txt.csv`) is the shape to worry about.
- **Migrations stay squashed until the first release.** `npm run db:generate` writes SQL from
  `src/db/schema.ts` into `backend/drizzle/`; migrations run when the database opens. No released
  database needs upgrading yet, so there is one initial migration and its snapshot, and a schema
  change is regenerated into it. From the first release on, applied migrations are immutable and each
  change gets a new one.
- **Categories are slugs** in the database and over the API; display names live in the client
  dictionary. The slug is a stable contract.
- **Goals survive missing accounts.** A goal-to-account row has no account foreign key, on purpose.
  Deleting an account leaves the goal visible with an `account-unavailable` status the person can act
  on. It never deletes the goal or silently points it at another account.
- **Nothing is required to start.** Every setting has a default that works on a machine with nothing
  installed. `.env` holds process settings. The app needs no secrets; the only one `.env` can hold is
  a password in a `DATABASE_URL` the person set. What a person edits in the app lives in the
  database, not in `.env`.
- **A diagnostic is not delivered until it survives every cap on its way to the screen.**
  `ERROR_DETAIL_MAX` bounds `imports.error_detail`, and `web/src/api.ts` shows all of it (its
  `MAX_ERROR_CHARS` is pinned to it by type). So clause order decides what is *dropped*, not what is
  read: actionable text first, refinements after. Append a clause whole or not at all, never cut
  mid-token: a truncated tail names things that do not exist. Read the current value before trusting
  it.
- **Silent success is the failure mode that matters.** A crash is recoverable. A 200 answer on data
  the user did not upload, or a partial import reported as complete, is not. When the choice is
  between refusing loudly and proceeding quietly, refuse.

## Verification has a hole

**The web suite** has two vitest projects, split by filename so the environment cannot be wrong:

- `unit`: `src/**/*.test.ts`, node, no DOM. Formatting, the slug dictionaries, how a refused request
  becomes a sentence.
- `dom`: `src/**/*.test.tsx`, jsdom and React Testing Library. A request to a route the test did not
  declare fails the test.

**What jsdom cannot see** is a limit of the environment, not a gap to fill:

- no layout and nothing from `styles.css`, so the only visibility fact is the `hidden` attribute;
- no real navigation and no download, so whether a file lands on disk cannot be checked;
- no chart rendering: recharts measures a 0×0 box, so a test can mount a donut and assert nothing.

These checks stay manual: open the screens in a real browser and record in the pull request which
ones, how, and what you saw. An agent driving a browser may do it too, except Settings' **Export
backup**, which writes every transaction to a file and is not an export an agent runs for anyone.
Mounting is not coverage, and **an unrecorded click leaves a screen unverified**: nothing downstream
can tell it from a run that never happened. Say which screens a green run covered; do not imply it
covered `web/`.

**The backend suite** runs on an in-memory PGlite by default, the engine the product runs on, and on
a real Postgres when `TEST_DATABASE_URL` is set. CI runs both. PGlite has one connection, so the
default run exercises no concurrency: not a unique index losing a race, not two writers meeting.

The suite runs in one process. `test/setup.ts` is a vitest setup file, so it runs **per test file**:
it truncates every schema table, seeds the defaults, and points `QUIETPURSE_HOME` at a temporary
folder so nothing reaches `~/Quietpurse`. Since it truncates what it connects to, it refuses a
`TEST_DATABASE_URL` database not named `test` or `*_test`. Files share the PGlite instance and the
module registry, not the rows; a file with exact figures repeats the truncate and the seed in its own
`beforeAll`, so its figures rest on its own lines.

**Coverage.** `npm run coverage` in either package prints a per-file reading of what the suite
reached. It is a reading, not a gate: no threshold, and no CI step reads it.

**Skips.** Some backend tests never run on Windows or as root, so a green local run there is short:
the boot refusal of a statements folder that cannot be written to (`test/documents.test.ts`), the
permission checks in `test/home-folder.test.ts`, and the lock's permission cases in
`test/lock.test.ts`, one of which skips on Windows only. CI (Ubuntu, non-root) runs them all. Nothing
else skips: `canvasabsent.test.ts` hides the package in a spawned child and runs everywhere.

## Conventions

**A module's code carries almost no comments; its reasoning lives in the module's `SPEC.md`.** That
moves the reasoning, it does not license deleting it: the keep list below protects what a spec is
for. A reason goes **where the edit that would break it is made**:

- Broken by an edit to its own line, it stays beside that line: a sentinel's meaning, a sign or
  rounding convention, why a clause is absent here, a rejected alternative a reader would retry here,
  an ordering this function's shape enforces, however far the coupling it serves reaches.
- Broken by an edit in another file, by someone who never opens this one, it goes to the spec: a
  coupling read from another file, an ownership boundary, a rejected module-level design, what a
  future producer owes.
- **A derivation whose content is its arithmetic stays in code, whole, beside the constant it
  bounds.** A spec cannot carry figures, and split across documents nobody owns the sum, so a part's
  premises can go false while its number still looks right. The spec says the chain exists, where it
  is written, and what it crosses.

**Specs.** A spec is a markdown file whose frontmatter carries an `id` and a `type`. The frontmatter
is the only copy of its title.

- `ARCHITECTURE.md` is the root. Every other spec is a `SPEC.md` beside its module and names its
  parent by id.
- Fields: `id`, `type`, `title`, `parent`, and, only where the code shows the edge,
  `depends-on`, `references`, `implements`. A line is `key: value` or `key: [a, b]`, nothing else.
- A module spec opens with `## Responsibility` and has `## Boundary` and `## Invariants` for the
  rules no type and no test holds. Its other sections are its own, and the root keeps its own.
- No line citation, commit sha, reference to the plan, or path a reader of the public tree cannot
  open. `backend/test/specs.test.ts` refuses each of these and any other form of frontmatter, and
  holds the parents to one tree. No counts either; review holds that one.

**A comment may not state a fact that something else could check.** Nothing tests prose, so a
number, count, measurement, reachability claim or inventory in a comment is believed long after it
turns false; comments here have been found false. If the fact matters, **assert it in a test and let
the comment give the reason.** The refusal bound in `pdf.test.ts` survived every rewrite because an
assertion sits beside its sentence; a comment in `csv.ts` that said "nothing reads it yet" went false
the moment something read it, and nothing said so.

- **Delete** on sight: a number, count, date, percentage, byte size, line number or file inventory;
  a row number, task id, review round or decision reference; what a test does, what a fixture holds,
  what a past run produced; what the next line already says; a section banner or divider.
- **Keep** beside the code only what cannot be recovered by reading the code, *and* would break
  behaviour if wrong, *and* is broken by an edit to its own line:
  - **why something is ABSENT**: a deliberate missing clause, filter or check that looks like an
    oversight. The most valuable kind, because absence has no syntax;
  - which of two readings that both compile is meant;
  - a rejected alternative a reader would retry, with the reason and not the story;
  - an ordering or coupling between distant parts of the code;
  - a unit, sign or rounding convention the type does not carry.
- Keep **far fewer than feels right**; the bar is the test, not a count. A loud failure does not
  justify a comment: the breakage has to be *silent*, and caused by an edit to that line. A file whose
  keeps are a data literal measured off a document no reader can open may honestly need a long keep
  list. If a comment mixes a kept reason with a checkable claim, cut it to the reason; no number "for
  context".
- `COMPUTED_PREFIX`'s docblock in `src/db/dedup.ts` is the shape to copy.

**Style.** Match the style, naming and idiom of the file you edit, **but never its comment volume**:
copying a dense neighbour is how the density spread.

**Git.** An agent never commits, pushes or runs `git add` unless asked. Work stays in the working
tree; the person it works for commits.

**No real statement enters the repository**: not as a fixture, not pasted into an issue or a pull
request. Fixtures are built in code with invented values (`backend/test/pdffixture.ts` for PDFs), and
`.gitignore` refuses every statement format for that reason.
