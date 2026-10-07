---
id: module-web
type: module-design
status: draft
title: web — the client's requests, month arithmetic, sentences and entry point
parent: architecture
---

What this package's source is for, where it stops, and the rules about it that no type and no test
holds. `AGENTS.md`'s *Platforms*, *Invariants* and *Verification has a hole* carry the contract, the
slug rule, the error budget and what a green run does not cover, and nothing below repeats them.
The code of the modules at the root of `web/src`, of the components in `web/src/components/` and of
the screens in `web/src/screens/` keeps what `AGENTS.md`'s *Conventions* names as a keep, and the
two month rules kept whole beside their functions are named below by symbol. A screen, or `Shell`,
is described here where a rule reaches into it. The test files under `web/src`,
`web/src/test/setup.ts` among them, keep their reasoning beside their code as well. The sections
after *Invariants*, *Overview presentation* excepted, open each paragraph on the symbol it is about,
so a rule is found by the symbol it governs.

## Responsibility

- **Every request the product makes**, composed in one module, `api.ts`, through one raw fetch
  rather than through an SDK.
- **The month arithmetic the server deliberately does not do.** The summary endpoints answer only
  the months an account has rows in, and two modules fill the rest in opposite directions —
  `accounts.ts` anchoring on the newest month with data and `analytics.ts` on the window the reader
  chose. Each rule is kept whole in the code, in the docblock directly above `windowMonths` and the
  docblock directly above `ticksOf`, because every clause of it is broken by an edit to that
  function and by nothing else. What `windowMonths`' rule crosses is `priorMonth`, `latestMonth` and
  the *vs* caption `AccountFlows` prints, which read adjacency in the filled array and never in the
  server's answer.
- **The sentences.** The API answers slugs and this package holds the dictionaries that turn them
  into something a person reads, an unknown slug included.
- **The entry point.** The app is `web/index.html`, and it is the only page this package builds.

## Boundary

**One module talks to the server.** `api.ts` is the only file in this package that calls `fetch`,
and no other transport appears anywhere in it — no `XMLHttpRequest`, no `EventSource`, no
`WebSocket`, no beacon. That is the boundary as measured, and **nothing enforces it**. The jsdom
harness replaces the global fetch and catches a request to a route no test declared, which is a
different rule: a second module fetching a route some test already declares is invisible to it, and
the `unit` project installs no stub at all.

**The browser holds the theme and nothing else of the reader's, and one legacy key on its way out.**
`AGENTS.md`'s *Platforms* states that no state lives only in the browser, because the REST API and
not this app is the contract a mobile client has to reach. The theme is the one deliberate exception:
a reader who pins dark on a phone and light on a desk has expressed two preferences, not one that
failed to sync, so `theme.tsx` writes it to `localStorage` and is the only module that stores
anything in the browser. The keys `url.ts` declares in `KEYS`, the screen, the account, the open
panel and the selected chart among them, live in the query string and are read back through that
module, and that is not a crossing: the URL is where the
reader *is*, not something a second client needs to reach — a native client has its own screens and
its own Back, and a server that has had no user since the product became single-user would be minting
per-user interface state to hold it. It is the query and never the path because the fallback in
`backend/src/app.ts` answers the app to any GET for a path that is not `/api` and not file-shaped —
a last segment carrying no extension, asked for by a request that accepts HTML — so a path scheme
would rest on that shape rule, two places agreeing on what a file looks like, where a query string
rests on nothing: the path stays whatever served the app, and `web/index.html` answers every URL
`url.ts` writes. The rule is held by `web/src/types.test.ts`, which walks the program the compiler
builds narrowed to the product files — the tests and the harness in `web/src/test/` set aside, by
the same cut the coverage reading makes — and requires every reference to `localStorage`,
`sessionStorage`, `indexedDB` or `document.cookie` to sit in one of two files and to be the
operations it names for each: `theme.tsx` may read and write its key, `analytics.ts` may read and
remove the legacy one, and nothing else may reach storage at all. The list is EQUAL in both
directions, so an entry nothing uses reds as an added file does. What the walk cannot see, stated
rather than closed: a string-keyed access (`window['localStorage']`), the Cache API,
`navigator.storage`, a service worker, a script in `web/index.html`, which the compiler does not
read, and a dependency that reaches storage on the product's behalf — a persist middleware, a
storage hook, a query-cache persister — where the identifier never appears in product source.

**The chart list was a crossing too and is not one any more.** It is read and written through
`api.ts` against the routes `backend/src/app.ts` serves over the table in `backend/src/db/schema.ts`,
so a chart follows a person to a second device. What is left of the browser copy is one read: the key
`analytics.ts` used to write is migrated into the database on the first load that finds one which has
never saved, and is not removed before the server has accepted a write, nor on a refusal. It
writes nothing, an installation that never
ran the browser-only list finds nothing under the key, and deleting it is a behaviour change this
document does not rule on. Two things came with the move that are the
client's alone and are held by cases in `web/src/screens/AnalyticsScreen.test.tsx` rather than by any
type: **one write is in flight at a time**, because two mutations sharing a version make the reader's
own second click look like another device's; and **a row this version cannot read is kept and sent
back**, because dropping it deletes it from every device the next time anything is saved.

**What a `Chart` carries is the wire's; what this package does with three of its fields is its
own.** The title is the reader's: the wizard suggests one from the draft until the reader types
their own, and never rewrites a typed one under them. `metrics` may be empty while the reader is
between two choices — the chips enforce no minimum — and a series chart in that state cannot be saved;
`ChartPlot` says so on the plot rather than drawing nothing. `accountId: null` is every account
together, which is what the summary endpoints answer without an id; an id that names no account is
not that, and `chartData.ts` refuses it rather than answering the whole under one account's title.

**A goal card renders the server's answer and never computes an outcome.** `/api/goals` supplies
the target, current value, remainder, status, percentage semantics and source line for every saved
goal. The list may format money and choose copy from closed dictionaries, but it may not derive a
fallback basis, progress, forecast, work-hours result or account total. Required monthly work
hours, configured monthly capacity and whether that capacity is exceeded all arrive from the server.
Goal-unit and progress-semantic formatters are exhaustive switches, so a wider server vocabulary is
a type error rather than plausible fallback copy. Status guidance names an action only when the
status has one cause: `needs-setup` can name essential costs, while `not-enough-data` stays neutral
because it can mean missing history or an unconverted row. Editing reads the complete configuration
from `/api/goals/:id`; the goal type is fixed after creation, and Financial independence costs are
replaced atomically with that configuration. The screen uses the shared `screen-inner` gutter at
its root, and each card's Edit and Delete controls include the goal name in their accessible name,
so narrow layouts and assistive action lists keep the card context.

**A goal editor does not render from partial dependencies.** Accounts, app settings and the saved
goal are one retryable load; a new attempt clears the previous account list and currency before any
form or type choice is enabled. Debt and savings-balance edits retain the goal's persisted currency
when a saved account is gone or no longer uses that currency. Savings selection locks to one currency
until the current selection is cleared; incompatible saved accounts remain removable and cannot
silently retarget the goal. A debt edit continues naming its saved account after the balance reaches
zero. Form refusals stay with their draft, but Back or a new type clears them; repeated
essential-cost controls carry their row ordinal in every accessible name.

**Goal selection is location, not product state.** The stable navigation key remains
`screen=goal`, while an optional `goal` query key opens the editor, for a new goal or a saved one. A
missing id, including one that disappears before an edit is saved, falls back to the list with an
explicit unavailable message rather than choosing another goal. A new installation's empty list is
a real empty state and is never shown while the request is unresolved or failed.

**The wire types are the server's declaration, reached by type only and through one door.**
`web/src/types.ts` declares nothing of its own but `TxFocus`: every wire shape in it is an `export
type … from` of `backend/src/wire`, so a field renamed on the server is a `tsc` error at every
reader in this package and never an `undefined` on a screen, and the fixtures in
`web/src/test/fixtures.ts` are held by the same derivation. The import is the statement form `import
type` / `export type` and never a value: a value import compiles, is erased by nothing, and bundles
zod and the wire module into the built client with both suites green. No other file under `web/src`
names the backend path; everything imports from `types.ts`. Both rules are held by
`web/src/types.test.ts`, which walks the program the compiler builds from `web/tsconfig.json` —
every file it compiles outside `node_modules` and `backend/`, the config files `include` names and
anything pulled in by resolution included, not a directory — for every form the compiler resolves,
and resolves each specifier the way the compiler does, so what is tested is the file a specifier
lands on: a `paths` or `baseUrl` mapping, a `rootDirs` overlay, a relay outside `web/src/` and a
file whose extension a directory filter would miss are all seen as the file they reach. Vite's
module graph is wider than the compiler's, and what only vite resolves is not walked here. The
tsconfig case beside it is a belt: it refuses `paths` and `baseUrl` outright, because either would
let a bare name reach `backend/` and the door's own text would stop saying where it goes, and the
row refuses a `paths` mapping to a second copy of zod. A `resolve.alias` in `web/vite.config.ts` is
not a door on its own — a value import through an alias `tsc` cannot resolve is `TS2307` before it
is anything else — and is one with an ambient `declare module` beside it, which is what lets `tsc`
resolve the name and which the walk does not see. The client's typecheck compiles the
wire module and resolves `zod` from `backend/node_modules`; `npm run setup` installs `backend/`
before it builds `web/`, and the order is load-bearing — reversed, the client's typecheck fails on
`zod` — which is also why the `web` job in `.github/workflows/ci.yml` installs it before its
typecheck: green on every machine with both packages installed, and `TS2307` on one without.

**The runtime copies the client keeps are pinned to the wire by type, in both directions, and their
order is the client's.** The wire's constants are values, and a value import is refused above, so
`analytics.ts` keeps its own copies of the chart bounds and the id charset, and `api.ts` its own
error cap, each written `satisfies typeof` the wire's export. A number or a character that differs
is a compile error. They are EQUAL to the server's and never merely within them. The charts route
refuses a whole list and not one chart in it, so a client bound under the server's truncates what
the server would have taken, one over it composes a list the server refuses whole, and a client
re-minting ids against a charset the route has narrowed is refused on every save from then on; and
the client shows the whole diagnostic budget, because the importer orders a refusal's clauses on the
premise that all of it is read, so a smaller cap deletes the clause it put last. Client-side
vocabularies are held twice — as the wire's union types and as exhaustive presentation records:
`analytics.ts` holds chart kinds, measures, breakdowns and ranges; the Goals presentation model
holds goal types, bases, income scopes and statuses; and
`web/src/components/IncomeSourcesBlock.tsx` holds income-source kinds. Each record is written
`satisfies` a `Record` over the wire's union, never annotated as one, and picker options are derived
from the applicable records rather than restating their members: a member the wire lacks and a wire
member the record omits are both compile errors whether or not the literal sits on the declaration,
where an annotated record holds the extra-member direction on a fresh literal alone. A client
narrower than the door cannot
draw a kind the server accepts: `parseChart` refuses the row, `chartEntry` keeps it as unreadable,
`entryWire` sends it back verbatim, and the screen names it rather than drawing it; a goal type it
lacks is a picker with no tile and no way to create it, and an income source kind it lacks is
a label read off a record by a key that is not there, which throws inside render and, with no error
boundary in this app, takes the whole app down with it; one wider composes a list nobody can save. Every pin assumes the wire's export
carries a literal type, and `web/src/types.test.ts` holds that premise under `tsc`: each client
constant is asserted equal to the wire export's type and each union equal to its record's keys, so a
wire constant widened to `number` or a tuple that lost its `as const` reds there rather than making
every pin silent. Membership is held and order is not: the wire's tuples are zod enums whose order
carries nothing, and the def arrays' order is the picker's layout, read off each record literal's
key order — which the language keeps for every key that is not an array index, so a vocabulary
member spelled as a bare integer would be the one that reorders.

**`copy.test.ts`, `tokens.test.ts` and `types.test.ts` are this package's own checks that read
source as text**, and all three resolve their root differently from the checks in the other package
on purpose. `backend/test/SPEC.md` states that rule and the reason for the divergence; it is not
restated here.

**A design token with no product reader, and a literal variable with no declaration, are refused**
by `tokens.test.ts`, because CSS fails silently at both ends. The reader walk excludes tests and
fixtures so an assertion cannot keep an unused role alive, and follows aliases from styling rules
rather than accepting a self-contained island of declarations. Variable resolution includes the
stylesheets and the palettes published by `theme.tsx`; the source check does not prove cascade
ownership, computed contrast or layout. Those require a rendered browser.

`API_BASE` is empty because the API is always this page's own origin: `web/vite.config.ts` proxies
`/api` to the backend while the dev server runs, and `npm start` serves the built client from the
backend itself, so nothing in this package configures an address and no request it makes is
cross-origin.

## Invariants

Support is available in the category picker, category filters and category rules. Its income
treatment belongs to the API: the client explains that it contributes to income but not to own
earnings. The separate editable income-source picker is hidden for incoming Support, because the
category already determines its external treatment. Expense signs, refunds and transfers retain
their usual meaning even when labelled Support. A category change into or out of Support is
answered by re-reading the whole list, as a rule apply is, and not by splicing the one row: the
server recomputes every transfer pair on that change, so the partner leg on another account may
have moved too, and the row the person touched is the one row a splice would get right. The detail
stays open on the updated row either way.

Transaction titles use the server's optional display description, with the source text available in
the detail panel. A distinct value date remains visible as metadata. Similar-transfer previews are
server results over the full account history, not a filter over the loaded rows. The preview explains
future matches and identifies manual overrides before the write. A refused write requires refreshing
the preview, and a successful write returns to the updated transaction rather than dismissing it.

The transfer button opens rule management. The category button applies the transaction's current
category to similar transactions after a preview. The preview names that category without asking
for it again; reading an existing rule or refreshing the matches must not replace it with the rule's
previous category. Rule actions use filled or outlined buttons.

Category rules keep their description-substring scope across all accounts, including hidden ones.
The initial pattern uses the server's display title so a bank's labelled value date does not narrow
the group. The server previews the entire history; editing the pattern invalidates that preview until
it is refreshed. Only confirmation in the preview writes the group rule. Manual category choices
remain exceptions, and existing rules remain accessible for inspection and removal. A category
change keeps the detail open even if the transaction leaves the current category filter, so the
person can immediately apply that choice to similar transactions. Returning to a category that
matches the filter restores the row. Group changes return to the detail and restore focus.

**The word for money somebody else gives you is written in more than one place, across both
packages, and nothing holds the copies to each other.** In this package it is the `support` entry
of `CATEGORY_LABELS`, which the picker, the category filter, the rule captions and the Transactions
list print; the prose that explains it in the Goals cards, in the income sources block under Settings
and in the Transactions detail sheet's hint; and the *Support* kind name in
`IncomeSourcesBlock`. One package over it is the label `seedDefaults` gives the seeded external
source in `backend/src/db/index.ts`. The packages share no build, `copy.test.ts` walks this side
looking for something else entirely, and no check compares them — so any copy can drift and every
test in both packages stays green. The seeded label is the person's own, and one who has renamed it
reads their own word. The
source the server derives from the Support category is the other way round — the summary answers
its id as its label and composes no word, and `incomeSourceLabel` in `categories.ts` turns a
`category:` id into the dictionary's word where the share chart prints the summary's sources, so
renaming the category renames the source with it. On the default seed the seeded source's label
and the category's word coincide, so a period with income under both draws two slices with one
word on the income-by-source share, and the chart tells the two apart by colour and figure. The
Transactions list badges outside help with the catalogue's label and gives a derived-source row no
badge, because that row's category already says what the money is.

**An income-source write invalidates every mounted reader before Settings re-reads its catalog.**
The Shell keeps its screens mounted while hidden, so one shared data revision reloads the Overview's
recent rows and figures for the account it shows, the transaction rows and source catalog, chart
data, goal progress and
Settings' recurring groups. The last reader matters because a source pattern can break a transfer
pair, which can turn the surviving expense into a recurring payment. The invalidation runs as soon
as the write succeeds: a failed follow-up catalog GET cannot suppress it. Transactions clears its
old source catalog during that reload and exposes a failed read with a retry rather than combining
freshly classified rows with stale names. Settings also clears its old source catalog after a
committed write: if the new read fails, Retry is available rather than actions on stale rows.
Financial setup's save invalidates the same readers when the server's answer carries owner names
other than the ones it held, whether or not that answer echoes the request: the server reclassifies
transfers before it answers. An answer that changed nothing invalidates nothing. One carrying a
new base currency arrives with every converted amount reset and refilled in the background, so the
block asks `GET /api/conversion` until no refill is running and invalidates once then, names and
all: a reader re-read in the gap would show it as the data — an empty recurring list, a zero total.
A names-only save made while that watch is open leaves the invalidation to it. A refill that stopped
with rows still unconverted is said beside the form, with how many, because stopping is not
finishing; a status that cannot be read is said with a Retry and invalidates nothing. The watch
ends with the block, so no poll outlives the screen that asked.
Revision-driven loads are latest-request-wins, so a slow pre-mutation response cannot replace the
newer answer.

**The account delete's counts — transactions, imports, documents — are what the delete removed from
the database, which for a hidden account is legitimately not what the panel previewed.** A document
in that answer is a removed import that claimed a stored file, counted whether or not its bytes were
still on disk. The preview counts a
hidden account by the server's total over its imports, because the transactions endpoint answers
nothing for one; the delete counts the rows carrying the account id. Transfer rules go too and are
not in the answer.

## The arithmetic a screen does on the server's figures

`toCents` is where money goes before it is added or subtracted — the rule, and nothing enforces it —
and it is exported because the rule does not stop at the module that declares it. Every amount the
server answers came off an integer number of cents and was divided by a hundred on the way out, so
it arrives as a double near the figure and not equal to it, and adding a few hundred of them keeps
the residue: a base that is zero to the last cent is a tiny residue instead, and a percentage taken
against it is a number whose size means nothing. So every comparison in `accounts.ts` is made in
cents, every sum in `analytics.ts` is accumulated as an integer and divided once at the end, and
`spendRing` in `categories.ts`, which takes the Overview ring's remainder off the same doubles, goes
through `toCents` rather than keeping a copy of it.

`monthOf`, `fmtDay` and `fmtMonthKey` split a calendar key on the string and never turn it into an
instant, because the server buckets a month with `SUBSTR` over the stored ISO date in
`backend/src/db/index.ts`, and anything that goes through a local `Date` disagrees with that for
everybody west of UTC — on the first of the month for a month key, and every time for a day off a
statement, which is a calendar day and not a moment. `fmtWeekday` takes a real instant on purpose —
today where the reader is — so its getters are the local ones.

`monthEnd` computes a month's last day in UTC from the key, and `accountSummary` and `accountMonths`
in `api.ts` take a calendar day as their `to`, because the summary routes in `backend/src/app.ts`
and the transaction query in `backend/src/db/index.ts` pad a `to` sent as a calendar day to the end
of that day: a `to` short by one day drops the last day of the range out of every figure it feeds,
silently, because a month missing its last day still looks like a month.

`SeriesPoint.net`, `AccountMonthTotals.net` and `MonthFlows` are three shapes with one word between
them, and the word means two things. `SeriesPoint.net` is income minus expenses, the bottom line of
a period, which a transfer between two of the reader's own accounts must not move.
`AccountMonthTotals.net` on the wire is every row of the month summed, transfers included — the
account months query in `backend/src/db/index.ts` puts the transfer filter inside the income and
expense sums and leaves `net` without it — which is what lets the months add up to the balance
printed beside them, and what `balanceChange` derives the opening balance from: no history of the
balance is stored anywhere, and the balance is the sum of every row, the rule
`recalcAccountBalanceFromTransactions` computes it by, so the balance before a month is today's
balance less that month's `net` and nothing else. `MonthFlows` carries no `net` at all, so a series
built from it cannot read the wrong one: the field is not in scope inside `seriesFromMonths`.

`MONTH_WINDOWS` is rendered by the Overview's toggle in the order it is written, and
`LONGEST_WINDOW` is read off it rather than written out because it is how far back the Overview
fetches before it can draw any window: a window added to the array must not leave the fetch one
step short of the toggle.

## What a chart is, and where its numbers come from

`CHART_KINDS` is what says whether a kind is a `series` chart, which plots measures across ticks, or
a `share` chart, which plots one period's parts against each other, and the difference is not
cosmetic: the two take different data, ask different endpoints and are configured by different
questions. `chartKind` is the one answer the wizard and the loader both read, so neither keeps a
list of names.

`useChartData` is the one seam between a chart and the server: `analytics.ts` holds the model and
the arithmetic that builds a chart's points and parts — nothing in it fetches or touches React, and
the series arithmetic takes `today` as an argument rather than reading a clock, so every series it
builds can be asserted against a fixed date — the components draw them and may add up what they
print, and `chartData.ts` turns a `Chart` into requests and the answers into something drawable. A field the reader sets in the wizard decides which shape of body the same two
endpoints come back with. Every account together is `/api/summary` and `/api/summary/months` with no
account named: the whole, converted into the base currency. One account is the same two with an
`accountId` on them: that account's own rows, in that account's own currency, with nothing
converted. Both arms are summed by the server with one rule — the queries in
`backend/src/db/index.ts` keep a transfer between the reader's own accounts out of income and out of
expenses on both, through `scopeSql`'s filter or inside the sums, and a refund subtracts from the
expenses of the period it landed in — so what differs is the unit, and a card must print the one it
was given: `currency` rides with the data, taken off the body that answered and never off the
accounts list.

`useChartData` distinguishes three states of the account list the screen hands it, and the screen
is what decides which one it is in. `accounts` is null while `web/src/screens/AnalyticsScreen.tsx`
is still reading the list, and that has to be told apart from read-and-this-account-is-not-in-it:
with the two flattened onto an empty array, every per-account chart on the screen printed that its
account was no longer here for the length of one request and then corrected itself.
`accountsError` is the third state and the reason the argument exists: the list stays null when the
read failed too, and a per-account card told only that it was still null waited on a request that
was never coming, with no error on the card and nothing to press. So a per-account chart waits only
while the list may still arrive, and a chart of every account never waits for it, because gating
that one on the list would fetch once on mount and again the moment the list landed, for every such
card on the screen. `data` is nulled before every load and never kept across one: a card holding
the previous range's points while the new range was in flight would print an axis labelled with
months it is no longer about.

`useChartData` resolves the account object only to refuse, and the loaders read no field of it: they
are handed the id alone. The currency that used to be read off the list went with the read, and
nothing is lost by it, because `backend/src/app.ts` refuses to change an account's currency once
the account holds a row, and refuses it while an import is waiting to be confirmed — so an account
whose code can still move has nothing on a chart to be mislabelled while a tab holds the old one,
and a chart's currency is the body's.

`loadShare` asks the every-account endpoint twice for a comparative kind, one request per window,
because `/api/summary` answers a split of the range it is given and there is no arithmetic on this
side that could take the earlier half back out of a doubled window. `loadShare`'s one-account arm
asks its endpoint twice for the same reason, stated for that arm on its own: both periods in one
window come back added together, and every category's `before` would be its own `now`.

`drawnShares`, and the `positiveShares` it is built on, write down in `analytics.ts` which parts a
kind draws, because the files drawing a chart were each answering what it was of and were free to
disagree — a card summed every slice for its total
while the donut in the middle of it summed only the positive ones, so one refunded category put two
totals on the same card. A refund can push a category negative, the purchase in an earlier period
and the refund in this one, and that is the honest figure: a ranking has a baseline and prints it,
and a donut or a radar has no such thing as a negative sector and drops it. `SharePoint.key` is the
backend's slug or the income source's id, and `ChartPlot` takes the React key from it, and the
colour too when the key is a category slug.

`parseChart` reads a stored row field by field and answers null for a shape this version does not
recognise, because a throw would take the whole screen down on first paint, and a row can have been
written by an older version of the client, by a hand-edited backup or by a version whose vocabulary
is wider than this one's; `chartEntry` then keeps the row as unreadable rather than dropping it, for
the reason *Boundary* gives. `parseChart` reads an empty `id` rather than refusing
it. In `backend/src/db/schema.ts` a chart's `id` is a primary key with no check on its content, and
`restoreBackup` in `backend/src/db/index.ts` type-checks each column against the table and sees no
zod schema, so a restore lets an empty id — or a title longer than the wire's cap — into the table,
and the next GET carries it out while the PUT route still refuses to take it back. The door is wider
on the way in than on the way out, which is why `normaliseForSave` cuts the list to what the route
will take on every save and not only in the migration: a row sent back as it came would fail the
route's bounds on the way out and refuse the reader's whole list, for ever, over content they never
typed.

`parseChartList` in `api.ts` is one parser for both bodies the charts route answers with, because
in `backend/src/app.ts` the 200 and the 409 carry the same `version` and `charts` pair. That is what
lets `ChartsStaleError` carry the current list — a client refused for staleness re-syncs from the
refusal and never asks a second time to find out what happened — and what makes re-syncing from a
refusal the same code as reading.

`ChartPlot` draws the `Chart` and the `ChartData` it is handed, and holds no state and fetches
nothing. That is what lets `ChartWizard`'s preview be the chart the card will draw, from the reader's
own data, rather than a mock that could disagree with it: a range is easier to judge from the plot
it produces than from its name. A fetch or a piece of state added to `ChartPlot` is one the preview
and the card would each run for themselves.

`ChartCard` is the chart as a picture and carries no control: editing, duplicating and deleting a
chart are done to it as an object, from its tab in `ChartDock`, because actions on the card put the
loudest row on the screen above the plot a reader came to look at. `ChartDock` sits under the chart
it chooses, as an index under its subject rather than a filter over it.

`ChartCard`, `AccountFlows` and `SpendingByCategory` each draw their plot hidden from a screen reader
and carry its numbers in a visually hidden table beside it — as measured — because the SVG is not
readable. `ChartWizard`'s preview draws `ChartPlot` with no table beside it, so its figures reach a
screen reader only once the chart is saved and drawn on a card. A future chart owes the pair
wherever it is the thing a reader is reading.

`isAnimationActive` is false on every series `ChartPlot`, `AccountFlows` and `SpendingByCategory`
draw — as measured, and nothing enforces it. The screens stay mounted, so a chart first renders
inside a hidden container, and an animation started there freezes at an arbitrary frame. It is also
why the stylesheet's reduced-motion rule has no chart counterpart: a chart has no motion to reduce.

`DOTTED_UP_TO` is declared in `AccountFlows` and again in `ChartPlot`, one rule and one value, and
nothing holds the two literals equal; the rule is written beside `ChartPlot`'s copy.

`ChartWizard` keeps `metrics` and `breakdown` in the draft across a change of shape, so switching a
donut to a line and back does not quietly discard the half that was not being read, and the charts
route takes both whatever the kind: `chartSchema` in `backend/src/app.ts` couples neither `metrics`
nor `breakdown` to `kind` and sets no minimum on `metrics`.

`AnalyticsScreen` holds no analysis of its own: it draws the charts the reader made, none of the
app's choosing. It draws one of them at a time rather than a grid, because the reader who made a
chart asked one question of it and one plot answers it, where a grid would leave that plot to be
found among the rest. What a chart id in the URL does is written under *Where the reader is*, and
how the list reaches the server under *Boundary*; neither is restated here.

`loadAccounts` in `AnalyticsScreen` reads the account list once, hidden accounts included, and the
screen hands that one answer to the card it draws and to `ChartWizard` rather than letting either
ask, because the answer is the same for every chart and the card is remounted each time the chart
on screen changes.

## Where the reader is

`useUrl` reads where the reader is off the URL, and the URL is the one store. Each reader calls
`useUrl` for the keys it needs, a key can have more than one reader, and Back has to move every
reader at once: a `useState` in any one of them cannot hear
`popstate`, and a copy in each is two copies to disagree, which is what the app had while these were
component state and had no answer to Back, to Reload or to a copied link. `useSyncExternalStore` is
the primitive for exactly this — the URL is the store and every reader subscribes to it — and it is
also what stopped the readers being wired to each other, since a fact none of them owns is read
from one place.

`read` answers an unchanged address with the very object it answered last, because
`useSyncExternalStore` compares snapshots by identity and a fresh object per read re-renders forever.
Snapshot identity follows the full published address, including path and fragment, even though
`AppUrl` exposes only the owned query values. Native hash navigation must refresh the real link
destinations without resetting a draft whose keys are unchanged. The publication seam observes
both `popstate` and `hashchange`; a trailing hash notification already handled by a traversal,
or made stale by its accepted write, cannot stage another guard or supersede that write. This
notification deduplication never substitutes URL equality for history-entry identity.

`urlFor` is exported because the navigation is anchors and an `href` is a promise about where a
click lands. `Shell.tsx` builds its anchors from it rather than composing a second address, because
two pieces of code that agree until one is edited fail invisibly from the app's own side — the click
still works, since the click never uses the `href` — and what would be wrong is the address in the
status bar, in the copied link and in the tab a middle click opens.

`AppUrl` validates none of its values; whatever reads a key validates it, and a key with more than
one reader is read by each for itself. `tabOf` in `Shell.tsx` folds an unknown `screen` to the
Overview, `web/src/screens/OverviewScreen.tsx` reads `panel` as the import panel, the history panel
or nothing, and the values the other keys carry, an account id and a chart id among them, name
things `url.ts` knows nothing about. The promise every key makes is the same: the URL says where
the reader was, and the reader's own data says whether that place still exists — a link carrying a
chart id opens that chart where it exists and falls back to the first chart where it does not,
exactly as `account` falls back to the first account.

`Shell` renders each section, including Settings after Import, as an anchor whose `href` is
`urlFor`'s address for the patch a click on it applies, so each is a link the browser can act on and
not only a control the app answers. `navigate`, the click handler on each of them, takes a click for
the app only when it is a primary click with no modifier held, and returns before `preventDefault`
otherwise, so every other click is the browser's: as measured in Chromium on Linux, a Ctrl+click or
a Shift+click on any of them opens that anchor's address in a new page and leaves the page it was
made on where it was.

`patchFor` in `Shell` sets `panel` to nothing on every section link, and
that is what closes a panel when the reader leaves its screen by one of those links. Settings'
import history is among the panels it closes: `SettingsScreen` keeps it in the URL as `panel` set
to `history`, rather than in state, so that this closes it. Back or Forward to an entry that carried
a panel opens it again.

`AppUrl` carries where the reader is and not how they have set a screen up: the Overview's chart
window and its switch for hidden accounts are component state on purpose, because a link that
carried them would override the setup of whoever opens it.

`useEditorSession` protects meaningful unsaved changes relative to caller-owned opening values.
Account names, income-source fields, goal inputs and chart configuration choose their own
comparison; generated cost keys and suggested chart names are not edits. Undoing changes restores
pristine dismissal. Keep editing and Discard changes share the existing shell, retaining its body
rather than remounting inputs. Builder Back preserves values; a different goal type requires explicit
discard before replacing incompatible fields. Immediate transaction writes do not acquire a draft
or a global Save action. Category-rule text compares with its opening pattern separately from
preview freshness: reading an edited preview does not commit that text or clear its leave guard.
A successful rule mutation establishes the new opening pattern immediately; a failed follow-up
transaction read remains a refresh error, not unsaved work that Discard could undo.
Discarding a navigation closes or resets the abandoned local editor without rewriting the history
entry being left; merely hiding a pristine editor retains its established screen lifetime.
Pending non-cancellable writes lock dismissal. A pending save of the draft also holds navigation
until it lands; an immediate transaction write or a read does not, and settles behind the hidden
screen instead. Confirmed and optimistic completion retain their existing owners and bypass only their own leave guard.

`registerNavigationGuard` stages app navigation before history writes or accepted side effects.
The published location is frozen during a blocked traversal, so an unrelated render cannot reset
an active editor from the address bar's new location. Managed entries carry namespaced
`__fintoNavigation` position metadata alongside foreign state. Opaque state remains untouched;
a native browser entry index supplies its traversal offset where available. Cancellation returns
to the original indexed entry, and acceptance replays the destination without pushing a duplicate
or deleting Forward destinations. Derived replacements retain their history role: `replace` is for
a value the app derived rather than one the reader chose, and it leaves no entry, or Back would land
on the address the app was about to correct and correct it again. Every open editor's guard is
asked, newest first, and one that accepts hands the navigation to the older ones, so closing one
editor never leaves another's draft unguarded. An address equal to the published one is not a
navigation, but the caller's acceptance still runs behind the guards unless a traversal is
unresolved.

An entry whose offset neither managed state nor the browser identifies is not compensated by a
guessed traversal, and only such an entry is reported as unverified: a restore or replay whose
offset is known is already on its way back, and announcing it would flash a warning that is false
by the next frame. The draft and published location remain until explicit acceptance, while the
address bar follows the browser's existing entry. Keep editing leaves a visible explanation of
that mismatch. An accepted app URL write waits at the source-entry boundary rather than replacing
the browser's displaced entry; its original push or replace role and callbacks are retained until
a verified source return. The owned-key intent is composed over that entry's current foreign
path, query, hash and state rather than replaying a frozen full address. URL equality alone cannot
prove that return when entries are opaque.
A newer intent supersedes the older navigation, and explicitly accepting another browser
destination abandons its queued URL change without undoing any confirmed server mutation.

Saving a goal is not deferred with its address update. A confirmed goal becomes a non-editable
result when its source entry is still displaced, with no second submission or unsaved-work claim.
The owning list refreshes immediately; only closing its URL editor waits. A late response belongs
to its opening: it may refresh committed data, but cannot mark a newer draft saved, release that
draft's write lock or close another goal selection. Optimistic chart writes
likewise keep their existing owner and closure, with the pending address update explained on the
workspace. The visible screen owns the navigation explanation even after its editor closes;
Sheet repeats it inside the active modal while that screen surface is inert. If the browser
exposes no usable source identity, automatic return cannot be promised;
the interface does not guess a traversal or overwrite a foreign entry to fake completion.
Full-document departure uses the browser's native unsaved-work prompt while an active session is
dirty or its pending save holds navigation, not browser storage or a recovery promise.
Inactive editors impose neither navigation nor document-departure guards. A committed write's
follow-up refresh retains focus-recovery intent until a replacement list arrives; Retry moves to
stable orientation before removing its own control.

## The sentences a person reads, and what is lifted out of a screen to hold them

`CATEGORY_LABELS`, `PROVIDER_LABELS` and `IMPORT_STATUS_LABELS` are the dictionaries the
*sentences* bullet above names, and nothing is ever sent back through them. No code path branches on
a `PROVIDER_LABELS` or an `IMPORT_STATUS_LABELS` label, so either can change without a slug moving.

`categoryRuleCaption` states the rule and counts transactions, and never says which category a row
ended up in, because two things one package over make that claim false: `overridden` in
`backend/src/db/index.ts` counts a hand-set row whatever the hand-set value was, so a row already
set to this rule's category is in it; and a newer overlapping rule keeps the rows this one matched,
because `makeCategoryRuleMatcher` in `backend/src/classify.ts` takes the first match over rules
listed newest first, and `addCategoryRule`'s upsert leaves `createdAt` alone.

`readAsSentence` is total over the wire's `kind` union and still answers a sentence in its default
arm rather than throwing. The union is the server's declaration by type, so a build of this app
cannot name an arm the server does not; but a body can still come from a server of another version
than the one this client was built from — the client is a build and the server runs from source, so
the two are not built together — or through a proxy, and there is no error boundary in this app.
The confirmation card the sentence is written for is where a staged import is confirmed or
discarded — as measured, nothing enforces it — so a throw in it would take the whole app down with
the import still staged.

`GENERIC_PRESET_TITLE` is the client's name for the generic reader and a prefix of the server's
title for it, deliberately not equal to it. The server's side of that coupling is held one package
over: `backend/test/upload.test.ts` pins the preset's title as starting with this string and names
this constant in its own comment, so a future producer of that title owes a string that still starts
with this one, and the chip that renders the long title and the sentence that names the short one
stay the same reader.

`rowCount` is the shape of the helper of the same name in `backend/src/providers/statement.ts`,
written twice on purpose: the two sit on two sides of a wire neither can import across, and a row
count in an importer's refusal and a row count on a screen should read alike. Each copy is broken
only by an edit to itself, which is what makes two copies correct here.

`tooltipProps` and the arithmetic in `analytics.ts` live in modules with no JSX rather than in the
components that draw them, because a chart in jsdom is a box with no size — recharts draws nothing
there — so a screen test can mount a chart and assert nothing about it. What lives there is held by
`unit` cases, against both palettes or a fixed date; what recharts reads off a datum by name and
never checks is pinned as text by `chartTooltip.test.ts`, as a list of named attributes and not as a
boundary.

`balanceClaim` lets the sentence about a running balance claim the run and never that the statement
is complete, because of where the balance's two ends come from: `checkSheet` in
`backend/src/providers/statement.ts` derives both from the rows it read, so a row lost from either
end of the statement moves that end instead of breaking the run, and nothing on this side can tell.
A PDF prints its opening and closing balances itself, and the rows adding up to them is what was
checked there.

`CsvImport`'s confirmed panel, its re-upload card and `ImportHistory` print the count of rows that
did not import without a cause, because none is kept: `rows_rejected` on the import row is the sum
of the rows that were unreadable, filtered by a status or moved no money — the `DropKind` buckets in
`backend/src/providers/statement.ts` — and does not say which. The breakdown is on the summary card
before Confirm, and a cause repeated afterwards would be a claim about rows none of the three can
see.

`CsvImport` stages a read for review rather than treating it as an import. Preparation is the working
surface only until the read begins; a review or outcome replaces it, retaining the source identity
and destination beside the server's answer. A staged source changes through explicit discard, not
through editable setup beside Confirm. Optional presets belong to preparation and retry. Parser
refusals remain whole, accompanied by web-supported next steps rather than a promised mapping editor.
Every available staged problem remains visible before confirmation. A failed confirmation is an
unverified outcome, not proof that nothing was written. The review retains its raw refusal and a
non-pending exit for checking persisted history or transactions; it never synthesizes confirmed
counts or claims that leaving discards the import. Its reader sentence precedes
every figure because it qualifies what those figures mean; the balance pair, when present,
is opening to closing, while its claim stays in the details because a continuous run cannot prove
the statement is complete. Without a pair the metric is absent, and a reason is shown only when the
server supplies one. Parser problems on a staged read are warnings, not fatal request errors; the
review's sentences remain visible without disclosure before the person confirms. Confirmed counts
come from the confirm response, and only an inserted row gives the confirmed headline success ink.

`CsvImport` keeps a newly created account visible as its own notice until Confirm reports that rows
landed in that account. A zero-insert confirmation leaves it standing: the account was written before
the upload, and the lack of imported rows does not undo that write. Successful reads, confirmations
and discards move focus to their new review or result heading, outside the normal Tab sequence, so
the person reaches the answer without having to find it below setup.

`CsvImport`'s re-upload card and the note `deduplicated` gates in `ImportHistory` never say where a
file's rows are now. Of the two, only the card states what the earlier import recorded when its file
was read: its counts are that import row's own, written when the import was staged or copied in by a
restore. The note is gated on a count `listImports` takes when the history is read, and keeps to the
rule only by what it does not claim. `import_id` names the first writer and not every attestation —
*Import provenance, and what an import's row promises* in `backend/src/db/SPEC.md` — so deleting an
earlier import takes with it the rows a later import's file also contained, the later import stays
committed, and its file still answers `duplicate`. Nothing on the wire can tell the card that has
happened, so a sentence placing the file's rows in the data would go on being printed over data that
no longer holds them. The count the card prints as the file's rows is the duplicate answer's
`total`, the import's accepted and dropped rows added together. For an import this code staged, that
sum is the data rows the file's reader handed `mapAndStore` in `backend/src/providers/statement.ts`,
because it refuses a read whose accepted and dropped rows do not add up to those. Rows a reader does
not hand over are in neither count, so for a file that has any the card counts fewer rows than the
file has, as the confirmed panel's heading already does with the same sum. Rows left out that way
include those on a workbook's other sheets, since `readXlsx` in `backend/src/providers/xlsx.ts`
hands over rows from one sheet and the import row records nothing about any other. They also include
the dated lines of a PDF table its template declares `collect: false`, such as a Revolut statement's
pending section: `readPdf` in `backend/src/providers/pdf.ts` drops them before they become rows, and
no notice on any screen names them. `restoreBackup` in `backend/src/db/index.ts` copies both counts
as the backup file carries them and checks neither against the other, so for a restored import the
sum is what the backup says and nothing more.

`drops` in `CsvImport` leaves the filtered rows out of the summary card's sentences because the
backend's own line in `problems` counts them and names the status values that filtered them, as
many as fit and a count of the rest; a second count beside it would describe the same rows twice.

`IncomeSourcesBlock`'s pattern hint states the word floor `makeSourceMatcher` in
`backend/src/classify.ts` applies to a pattern, and nothing holds the two together, the same shape
as `categoryRuleCaption`'s coupling to that file: a pattern with too few words long enough to count
is accepted, stored and tags nothing, so the hint and the example in the editor field above it
must move together when the floor moves. The compact list counts stored patterns rather than
claiming that they match transactions; full phrases belong in the source editor Sheet, not the card.

## The palette, and what leaves the page

`ink` is the palette published a second time: the custom properties `ThemeProvider` sets on the
document root are the styling truth, and `ink` exists because recharts wants real colour strings.
Where the theme is kept is *Boundary*'s ruling and is not restated here. Action and selected-state
foregrounds belong to their grounds, not to whichever text role a consumer happened to inherit.
Brand identifies the product; success confirms an outcome; income identifies a financial series;
favorable and unfavorable interpret a comparison whose direction the caller supplies. Those roles
are independent even where hues are related. Legacy `good` and `bad` retain their existing readers'
meaning and are not aliases that reclassify every signed amount. Control boundaries and focus
have their own contrasting roles; a field's focus feedback is not merely a changed border.

`TOOLTIP_CHIP` gives every ground a chart is painted on a fill and the two colours that go on it, as
one value. A ground is named for the `Ink` key of its own fill, so nothing states twice what colour a
card is, and a ground added to the union without a chip does not compile. Each caller tells
`ChartPlot` whether it is on a card surface or the wizard's page preview. The chip fills the box with
`raised`, which sits a step off each ground on purpose; the border is what makes the box a box, not
the fill. `chartTooltip.test.ts` pins the tightest live fill-on-ground pair in each palette with the
border's separation beside it, at the measured figures rather than under a floor, and reds when a
figure written down is no longer the measurement.

`tooltipProps` is checked in `unit` against both palettes at once because `chartTooltip.ts` is a
`.ts` file and not a `.tsx` one on purpose: `web/vitest.config.ts` binds the project to the
filename, and in `dom` it could be checked against neither, since recharts draws no tooltip in
jsdom.

`saveBlob` is the one seam that turns bytes the API handed over into a file. It is split out of the
components so that the one call to `URL.createObjectURL` takes a `Blob` and nothing else — no
`Response`, no path — so a body nobody checked cannot become a file; as measured it is the only
object URL this package creates, and nothing enforces that.

`safeFilename` is the server's `attachmentDisposition` done client-side — the reader's own name,
then the id-derived one, then a constant — and `MAX_FILENAME_CHARS` is a copy of the cap `cleanName`
in `backend/src/app.ts` slices at, so a name is not cut differently at the two ends. Unlike the
copies *Boundary* describes, it is pinned to the server by neither a type nor a test.
The client's cleaning is not the server's `cleanName` for a reason: nothing here is percent-encoded,
so the server's lone-surrogate rule has nothing to protect, and a `download` attribute is UTF-8 with
no ASCII half.

`ChartPlot` colours a series by the `Ink` key its entry in `METRICS` names, so what income or
expenses look like is not decided in the plot, and colours a share part by `sliceColor`: a key that
is a category slug takes that category's `categoryColor`, and any other key takes a colour off
`RAMP` by its position. `RAMP` is a list of category slugs rather than of colours, so the two
schemes keep answering for themselves. An income source whose id is also a category slug is
coloured as that category.

`ChartPlot`'s donut key marks each part with the round `.dot` and its series legend with the square
`.swatch`. As measured, and enforced by nothing, every `.dot` in the product's markup marks a
category or a sector of a ring — the donut's key, the Overview ring's legend, and the Transactions
list and its category picker — and every `.swatch` marks a series or a period.

## Presentation foundations

`web/src/styles/tokens.css` owns shared type, spacing, control, radius, motion and measure roles; color
remains the palette's. Text roles separate orientation, reading, labels, helper text and metadata
from comparable financial numbers. Numeric styling changes neither signs nor formatting. Inputs
stay readable on narrow layouts; ordinary text and controls may grow with the reader's text size.

`screen-inner` establishes the shared outer page anchor and responsive gutters. Wide data, normal
composition and narrow editing measures limit breadth without independently centering subordinate
regions. Settings uses the normal outer measure with a narrower financial form inside it. Existing
scoped screen compositions retain their own treatment rather than acquiring a new wrapper. Screen
scrolling, hidden-screen exclusion and navigation safe-area clearance remain the shell's concern.

Grouped surfaces remain flat, subordinate relationships use spacing, and transient dialogs have a
separate radius from ordinary cards. Focus is visible on the actual ground; reduced-motion behavior
does not depend on transitions to establish the final state.

`Button` owns native action presentation with explicit type, variant and size. Foreground and ground
are a pair; legacy action classes do not choose either for a migrated button. Native disabled and
focus-retaining locked actions use a readable neutral pair and a visible dashed boundary rather
than relying on the cursor or faded text. Pending keeps that locked treatment and adds its own
indicator without changing the action's label or dimensions. Locked actions refuse activation.
The legacy filled `btn btn-danger` combination shares `btn-destroy`'s complete danger pair and
interaction states until consumer migration retires those classes; a standalone `btn-danger`
remains a lower-emphasis text action rather than acquiring the filled confirmation treatment.
`FormActions` keeps supporting navigation before dismissal and completion in reading order;
narrow layouts put completion on its own row rather than reshuffling keyboard order.

`Field` renders an explicitly identified native control with a persistent visible label and
associated help and correction. It supplies no validation rules. `Notice` renders facts and
remedies chosen by its owner; its tone does not establish success, emptiness or availability,
and live announcements are deliberate caller choices. `PageHeader` groups orientation, return
context and the leading action without introducing another outer page anchor.

## Overview presentation

Overview keeps each account's native currency. Its summaries are loaded together after the recent
transactions identify the newest month with data; an obsolete account request must not replace
what a later selection has loaded. Each card names the period from its own response. Balance
comparison uses the month's net movement, including transfers, while the flow figures exclude
transfers. Neither a balance history nor an update timestamp may be inferred from the recent list.

The spending ring can only draw positive values. Its centre and legend retain the server's net
expense figures, including refunds, and the remainder is subtracted in cents. The ring's grouped
remainder includes positive categories even when a refund elsewhere in that group offsets them;
the explanation must remain visible whenever those net figures differ from what can be drawn.
`spendRing` in `categories.ts` is where the drawn sectors and the legend's remainder part ways, so
the two figures are one function's answer and `categories.test.ts` can hold them apart on a fixture
whose tail nets to nothing. The ring's named sectors and their legend dots are coloured by rank, not
by category — the slot's ink keys and how many categories the legend names are one literal,
`RING_SLOT_INK` in `categories.ts` — so the Overview ring is the one chart where a category's colour
is its position and not the colour `categoryColor` gives it everywhere else.
The accessible tables live inside clipped wrappers: clipping the table itself leaves its intrinsic
width able to widen a narrow page.

Navigation uses the same links for the desktop sidebar and mobile bar. Import remains a desktop
navigation link and a panel of Overview, while Settings takes its place in the mobile bar; Import
is still reachable from Overview and Settings. Screens stay mounted so filters survive navigation,
with inactive screens excluded through `hidden`. Settings separates financial setup from income
classification, then presents recurring payments, data and backup actions, and API connection
information in that order. The API address stays in a closed-by-default Advanced disclosure: it
identifies this page's local REST API, not a preference the reader can change. Pending reads and
failures belong to their respective regions, never to a page-wide empty result. Financial setup
shows the server's currency with a readable name when one is available; suggestions never
restrict the code the server may accept. Adding, removing or entering an owner spelling changes
only the local form; Save includes a name still in the entry field in the ordered list. A comma in
the entry separates spellings. Removing a spelling hands focus to the next one, the previous one,
or the entry field. Only an exact echo of the requested currency and ordered names resets the form
to saved; a refusal or different answer leaves the edits available to correct or retry, and a
different answer names what the server kept, since the fields still show the edits. Validation and recalculation
remain with the server. Settings' recurring list uses the server's monthly estimate and detected groups without recomputing them; category markers come from the
category palette, not guessed merchant identities. Excluded groups stay in a collapsed disclosure
rather than disappearing, and a mutation replaces the whole recurring answer instead of patching
one row. A group is followed across answers by the server's `key`, not its description: the
description is the group's newest spelling and moves between reads. Revision-triggered reads and
mutations share one latest-answer guard so an older reply cannot replace newer recurring data, and
a write overtaken by a newer answer re-reads only when that answer does not already show the write
done. A newer answer only makes a failed exclude or restore
irrelevant when that payment is gone or already in the requested state; an in-flight read or one
that still leaves the action available does not erase the refusal. A refusal belongs to its
payment: an action on another payment neither clears nor replaces it. Refusals are shown apart
from a failed read, which keeps its own Retry for the read; neither hides the other, nor the
loading status. A control on Settings that would turn disabled while it holds focus — a save
pressed or entered, a name just added, a save answered with nothing left to save, an exclude,
restore or delete in flight, Add source once its form is open — is `aria-disabled` instead and
ignores a press, and a field being sent is read-only: a browser drops focus from a control
disabled under it, a refusal would then hand it back to nothing, and inside a sheet the Tab trap
would have nothing to hold. The income-source form is locked while its save is out because the
save already took its values, and the sheet that closes on success would drop an edit made
meanwhile. After a write,
focus goes to the section's heading only when it was lost or is still inside the card. The summary
total shows only beside detected groups. Import and history navigate to
their respective flows; backup uses the checked fetch path and produces a file only after a successful response. A
refusal stays beside Export, not elsewhere on Settings. The account strip marks the current
account with `aria-current` like the navigation does and is deliberately not a tablist: that is the app's one idiom for which of these is the current one, and a tablist makes
the strip a composite widget with a roving tabindex nobody asked for. The account's import
button enters the existing staged import flow, where the destination is explicitly selected and
confirmed. A currently viewed account is not evidence that the next statement belongs to it.

Dark is the initial theme; an existing saved choice takes precedence. The shell offers System,
Light and Dark as explicit choices, with System following the OS preference. Its theme control
moves between the bottom of the desktop sidebar and the mobile top bar, while the local-storage
indicator stays in the sidebar. Colours are published from `theme.tsx` to CSS and chart components
together. Income series and their legend marks use the income role, independent of action and
success colors; expense series retain `lavender`. Chart tooltips use
a raised surface with its own text colours rather than inheriting colours from the plotted series.

## Accounts and statements, as the client handles them

`CsvImport` reads the account list with no argument and filters nothing itself: the server leaves a
hidden account out of that list, and `POST /api/imports` refuses a hidden account's id, so a filter
here would render the same list while moving the decision to the layer that does not hold it. An
account is created by its own request and never by an upload — the upload route refuses
`accountName` and `currency` outright — so the create arm makes the account before the file is
uploaded.

`ImportHistory`, when it is handed an `account`, and `AccountDialog`'s delete preview ask
`api.imports` for that one account by its id and never match on `accountName`: the server filters
imports on the account id, and the name an import row carries is the account's name when the
statement was staged, which a later rename leaves behind. The caller supplies the history's return
destination label; workspace-wide history does not pretend to be an account's panel.

`ImportHistory` gives source identity the record's full reading width before allocating actions on
narrow screens. Counts describe accepted, rejected and owned rows, never an inferred file total.
Download requires a readable document claim; file deletion remains reachable without it because
unclaimed bytes may still need removal. A named ordinary-button group exposes removal, then closes
before the shared confirmation names the source, operation and ownership consequences. File deletion
preserves data and does not invalidate financial readers; import deletion does. A failed list reload
retains the previous records with a visible refusal and retry, rather than reporting empty history.
Removal retains recovery intent through that reload and any retry; file-only removal returns to
the same record, while removed imports return to a surviving control or history orientation.
Recovery owns only lost focus or its own restored target, not a later user choice or another
confirmation's opener. Explicit Retry reclaims stable heading orientation before replacing its
control and can then apply the retained removal intent.

`AccountDialog`'s delete gate compares the typed name trimmed and case-insensitively because the
server trims a name before storing it and `accounts_name_unique` in `backend/src/db/schema.ts` is on
the lower-cased name: a gate demanding the capitals back would refuse a name the server calls
identical to the one on the tab.

`COUNT_LIMIT` is what `AccountDialog`'s delete preview asks the transactions endpoint for, because
that endpoint takes a limit and answers a bare list with nothing about what it cut: the preview asks
for more than a count could plausibly be and says so when the answer comes back full. A server that
capped the limit below `COUNT_LIMIT` would make a cut answer read as a whole count.

`AccountTabs` is handed the accounts in the order the Overview puts on the rail — the server's
order, by provider and then by name, with the hidden accounts after the visible ones when they are
shown — so a rename can carry the selected account to another page on the next load, which is the
case the strip's paging effect follows.

## What the shared controls promise

`Sheet` owns modal containment, reversible background inertness and scrolling while its screen
is visible. Tab recovers even after the focused control disappears. Opening and deliberate step
changes enter the caller's target or heading; draft renders do not move the caret. The opener is
captured before children can take focus. Restoration requires a usable surviving target, with a
caller-supplied section or record fallback when the opener is gone. A noninteractive fallback
receives programmatic focus without joining the Tab sequence, even on direct entry before Shell
has oriented the screen. Native focusable record controls keep their existing Tab position.
Income-source refresh retains its own asynchronous fallback rather than competing with generic
restoration.

Long editors and builders ignore the backdrop; a pristine short editor or confirmation may request
close only from a press that began on the backdrop. Escape and the named close control request the
same caller dismissal policy. Pending non-cancellable writes block conflicting dismissal. The
shared frame provides a primary scrolling body and optional header and action regions; subordinate
fields and preview records do not establish competing scroll areas. When framing leaves too little
space for a labeled control, orientation and actions return to the same scrolling flow. This uses
actual text and control geometry rather than assuming a short viewport has ordinary-sized text;
mode changes and Keep editing bring the focused control into view without resetting its caret.
Later content reflow keeps that control visible even when the scrolling mode is unchanged; recovery
waits for overflow layout to settle and acts on the current focus, not a previously captured target.
Associated fieldsets and semantic groups remain part of that measurement even when individual
options fit. The test harness keeps resize observation present as a controlled notification seam;
cases supply geometry and notifications explicitly, rather than treating the stub as optional or
as evidence of browser layout.

A screen owns only one active modal decision. In Goals, an accepted URL editor replaces any
local delete confirmation before either shell acquires modality; Back does not resurrect that
abandoned confirmation. Pending deletion still blocks navigation through its existing session.

An open sheet on an inactive screen retains its state but releases focus, inertness, scroll locks
and keyboard ownership. Returning re-enters without replacing the original opener. Shell drives
`hidden` and `ScreenShown` from the same value. Modal layering stays above raised popovers.
Accepted screen or panel navigation orients the reader at the visible heading, not on background
refresh or filter changes and not over an editor's own focus policy.

`useDismiss` is the Escape-and-outside-press seam for lightweight popovers. A live child receives
Escape before its sheet; a background popover beneath the modal cannot consume that dismissal.
Like a sheet, it hears nothing while its screen is hidden.
`Chips` takes `locked`, which marks every chip `aria-disabled` and ignores a press, for a form
whose values are already on their way.

`aria-current` is the app's idiom for which of a set is the current one — on the navigation's
links, and on plain buttons in `AccountTabs`' account strip and `ChartDock`'s chart strip, neither
of which is a tablist, because a tablist makes a strip a composite widget with a roving tabindex.
`aria-pressed` on a button is its idiom for a choice, `Chips` and `ChartWizard`'s `Choice` among
them, rather than a radio group. As measured, and enforced by nothing, the product's markup carries
no `role="tablist"`, `role="tab"`, `role="radio"`, `type="radio"`, `role="menu"` or
`role="menuitem"`.

`NavIcons` and `ChartGlyphs` draw in `currentColor` and are `aria-hidden`: where one sits inside a
control that carries its name in text, a drawing announced beside the name would be the name twice,
and a drawing inherits its colour from the elements it sits in.
