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
The reasoning behind the modules at the root of `web/src` lives in this document, `App.tsx` and
`Shell.tsx` excepted. Their code keeps only what `AGENTS.md`'s *Conventions* names as a keep, and the
two month rules kept whole beside their functions are named below by symbol. The components and the
screens under this directory, and the two files excepted above, are described here only where a rule
above the root reaches into one; their own reasoning is beside their code. The test files under
`web/src`, `web/src/test/setup.ts` among them, keep their reasoning beside their code as well. The
sections after *Invariants* open each paragraph on the symbol it is
about, so a rule is found by the symbol it governs.

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
anything in the browser. The screen, the account, the open panel and the selected chart live in the
query string and are read back through `url.ts`, and that is not a crossing: the URL is where the
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
never saved, and removed once that write is answered. It writes nothing, an installation that never
ran the browser-only list finds nothing under the key, and deleting it is a behaviour change this
document does not rule on. Two things came with the move that are the
client's alone and are held by cases in `web/src/screens/AnalyticsScreen.test.tsx` rather than by any
type: **one write is in flight at a time**, because two mutations sharing a version make the reader's
own second click look like another device's; and **a row this version cannot read is kept and sent
back**, because dropping it deletes it from every device the next time anything is saved.

**What a `Chart` carries is the wire's; what this package does with three of its fields is its
own.** The title is the reader's: the wizard suggests one from the draft until the reader types
their own, and never rewrites a typed one under them. `metrics` may be empty while the reader is
between two choices — the chips enforce no minimum — and a chart in that state cannot be saved;
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
form or type choice is enabled. Account-backed edits retain the goal's persisted currency when a
saved account is gone. Savings selection locks to one currency until the current selection is
cleared, and unavailable saved ids remain removable. Form refusals stay with their draft, but Back
or a new type clears them; repeated essential-cost controls carry row context in their accessible
names.

**Goal selection is location, not product state.** The stable navigation key remains
`screen=goal`, while an optional `goal` query key identifies the editor or detail being viewed. A
missing id falls back to the list with an explicit unavailable message rather than choosing another
goal. A new installation's empty list is a real empty state and is never shown while the request is
unresolved or failed.

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
a label read off a record by a key that is not there, which throws inside render and takes the Settings
screen down with it; one wider composes a list nobody can save. Every pin assumes the wire's export
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

**A design token with no `var()` behind it is refused**, by `tokens.test.ts`, because
`web/src/styles/tokens.css` is the one place the radii, motion and stacking values two stylesheets
had to agree on were pulled into — the palette left it for `theme.tsx` — and CSS fails silently at
both ends: an unread declaration costs nothing, and a rule naming one that does not exist takes the
initial value rather than erroring. The check holds one direction only; its own header says which
and why the other needs three declaration sources modelled at once.

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
reads their own word, which is what the delete confirmation looks up rather than writes out. The
source the server derives from the Support category is the other way round — the summary answers
its id as its label and composes no word, and `incomeSourceLabel` in `categories.ts` turns a
`category:` id into the dictionary's word where the share chart prints the summary's sources, so
renaming the category renames the source with it. On the default seed the seeded source's label
and the category's word coincide, so a period with income under both draws two slices with one
word on the income-by-source share, and the chart tells the two apart by colour and figure. The
Transactions list badges outside help with the catalogue's label and gives a derived-source row no
badge, because that row's category already says what the money is.

**An income-source write invalidates every mounted reader before Settings re-reads its catalog.**
The Shell keeps Transactions, Analytics and Goals mounted while hidden, so one shared data revision
reloads the transaction rows and source catalog, chart data and goal progress. The invalidation runs
as soon as the write succeeds: a failed follow-up catalog GET cannot suppress it. Revision-driven
loads are latest-request-wins, so a slow pre-mutation response cannot replace the newer answer.

**The account delete's counts — transactions, imports, documents — are what the delete destroyed,
which for a hidden account is legitimately not what the panel previewed.** The preview counts a
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
`web/src/components/SpendingByCategory.tsx`, which takes a remainder off the same doubles, goes
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
the arithmetic — nothing in it fetches or touches React, and the series arithmetic takes `today` as
an argument rather than reading a clock, so every series it builds can be asserted against a fixed
date — the components draw, and `chartData.ts` turns a `Chart` into requests and the answers into
something drawable. A field the reader sets in the wizard decides which shape of body the same two
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

`drawnShares` decides in one place which parts a kind draws, because the files drawing a chart were
each answering what it was of and were free to disagree — a card summed every slice for its total
while the donut in the middle of it summed only the positive ones, so one refunded category put two
totals on the same card. A refund can push a category negative, the purchase in an earlier period
and the refund in this one, and that is the honest figure: a ranking has a baseline and prints it,
and a donut or a radar has no such thing as a negative sector and drops it. `SharePoint.key` is the
backend's slug or the income source's id, and `ChartPlot` takes both the colour and the React key
from it.

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

## Where the reader is

`useUrl` reads where the reader is off the URL, and the URL is the one store. The navigation in
`Shell.tsx` reads `screen`, the Overview reads `account` and `panel`, the Analytics screen reads
`chart`, and Back has to move all of them at once: a `useState` in any one of them cannot hear
`popstate`, and a copy in each is two copies to disagree, which is what the app had while these were
component state and had no answer to Back, to Reload or to a copied link. `useSyncExternalStore` is
the primitive for exactly this — the URL is the store and every reader subscribes to it — and it is
also what stopped the readers being wired to each other, since a fact none of them owns is read
from one place.

`urlFor` is exported because the navigation is anchors and an `href` is a promise about where a
click lands. `Shell.tsx` builds its anchors from it rather than composing a second address, because
two pieces of code that agree until one is edited fail invisibly from the app's own side — the click
still works, since the click never uses the `href` — and what would be wrong is the address in the
status bar, in the copied link and in the tab a middle click opens.

`AppUrl` validates none of its values; the reader of each key does. `tabOf` in `Shell.tsx` folds an
unknown `screen` to the Overview, `web/src/screens/OverviewScreen.tsx` reads `panel` as the import
panel, the history panel or nothing, and `account` and `chart` name things `url.ts` knows nothing
about. The promise every key makes is the same: the URL says where the reader was, and the reader's
own data says whether that place still exists — a link carrying a chart id opens that chart where it
exists and falls back to the first chart where it does not, exactly as `account` falls back to the
first account.

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
discarded — as measured, nothing enforces it — so a throw in it would leave the import stuck, with
nothing on screen to release it.

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
screens that draw them, because a chart in jsdom is a box with no size — recharts draws nothing
there — so a screen test can mount a chart and assert nothing about it. What lives there is held by
`unit` cases, against both palettes or a fixed date; what recharts reads off a datum by name and
never checks is pinned as text by `chartTooltip.test.ts`, as a list of named attributes and not as a
boundary.

## The palette, and what leaves the page

`ink` is the palette published a second time: the custom properties `ThemeProvider` sets on the
document root are the styling truth, and `ink` exists because recharts wants real colour strings.
Where the theme is kept is *Boundary*'s ruling and is not restated here.

`TOOLTIP_CHIP` gives every ground a chart is painted on a fill and the two colours that go on it, as
one value, because the ground decides the tooltip's colours and one shared object is what keeps the
surfaces from diverging — a reader who learns that pointing at a chart works on one screen would
otherwise learn it wrongly for the next. A ground is named for the `Ink` key of its own fill, so
nothing states twice what colour a card is, and a ground added to the union without a chip does not
compile. The one chip every ground takes fills the box with `raised`, which sits a step off each
ground on purpose; the border is what makes the box a box, not the fill. `chartTooltip.test.ts` pins
the tightest live fill-on-ground pair in each palette with the border's separation beside it, at
the measured figures rather than under a floor, and reds when a figure written down is no longer
the measurement.

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

Navigation uses the same links for the desktop sidebar and mobile bar. Screens stay mounted so
filters survive navigation, with inactive screens excluded through `hidden`. The account strip
marks the current account with `aria-current` like the navigation does and is deliberately not a
tablist: that is the app's one idiom for which of these is the current one, and a tablist makes
each tab a composite widget with a roving tabindex nobody asked for. The account's import
button enters the existing staged import flow, where the destination is explicitly selected and
confirmed. A currently viewed account is not evidence that the next statement belongs to it.

Dark is the initial theme; an existing saved choice takes precedence. Colours are published from
`theme.tsx` to CSS and chart components together. The action accent and income may share a colour,
so expense series use `lavender` to remain distinct on the other screens as well. Chart tooltips use
a raised surface with its own text colours rather than inheriting colours from the plotted series.
