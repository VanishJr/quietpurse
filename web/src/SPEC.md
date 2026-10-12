---
id: module-web
type: module-design
status: draft
title: The web client's requests, month arithmetic, sentences and entry point
parent: architecture
---

## Responsibility

`AGENTS.md` holds the contract (*Platforms*), the slug rule and the error budget (*Invariants*), and
what a green run misses (*Verification has a hole*); this file does not repeat them. The code keeps
what *Conventions* names as a keep, and the tests, `web/src/test/setup.ts` among them, keep their
reasoning in their own comments. A behaviour a test already holds is left to that test; what stays
here is what no type and no test holds. A screen is described only where such a rule reaches into
it. Most paragraphs open on the symbol they govern.

- **Every request**, in `api.ts`, through `fetch` directly rather than an SDK.
- **The month arithmetic the server deliberately does not do.** The summary endpoints answer only
  months that have rows. `accounts.ts` fills in the rest anchored on the newest month with data,
  `analytics.ts` anchored on the reader's window. Each rule is kept whole in the docblock above
  `windowMonths` and the one above `ticksOf`, because only an edit to that function breaks it.
  `windowMonths`' rule reaches `priorMonth`, `latestMonth` and the *vs* caption in `AccountFlows`,
  which read adjacency in the filled array, never in the server's answer.
- **The sentences**: the dictionaries that turn the API's slugs into words, an unknown slug
  included.
- **The entry point**: `web/index.html`, the only page this package builds.

## Boundary

**Only `api.ts` talks to the server.** It alone calls `fetch`, and the package uses no other
transport: no `XMLHttpRequest`, `EventSource`, `WebSocket` or beacon. Nothing enforces this. The
jsdom harness fails only a request to a route no test declared, so a second module fetching a
declared route passes, and the `unit` project stubs nothing.

**The browser keeps only the reader's theme, plus one legacy key on its way out.** *Platforms* keeps
all state behind the REST API, so a mobile client can reach it. The theme is the deliberate
exception: dark on a phone and light on a desk are two preferences, not a failed sync. `theme.tsx`
writes it to `localStorage`.

The keys in `url.ts`'s `KEYS` (screen, account, panel, chart, goal), and the position marker
`url.ts` keeps in `history.state`, are not a crossing: they say where the reader *is*. A native
client has its own screens and its own Back, and a single-user server would store per-user interface
state for nobody. They go in the query, not the path, because the fallback in `backend/src/app.ts`
serves the app for a GET outside `/api` whose last segment has no extension and that accepts HTML. A
path scheme would depend on two places agreeing what a file looks like. A query depends on nothing,
and `web/index.html` answers every URL `url.ts` writes.

`web/src/types.test.ts` holds the storage rule over product files, with tests and `web/src/test/`
set aside as in the coverage reading. Every reference to `localStorage`, `sessionStorage`,
`indexedDB` or `document.cookie` must sit in `theme.tsx`, which may read and write its key, or in
`analytics.ts`, which may read and remove the legacy one. The list is checked both ways, so an
unused entry fails like an extra file. The walk cannot see a string-keyed access
(`window['localStorage']`), the Cache API, `navigator.storage`, a service worker, a script in
`web/index.html` (the compiler does not read it), or a dependency that stores for the product (a
persist middleware, a storage hook, a query-cache persister), whose identifier never appears in
product source.

**The chart list lives on the server**, read and written by `api.ts` through the routes in
`backend/src/app.ts` over the table in `backend/src/db/schema.ts`, so charts follow the reader to
another device. The legacy browser key is read once: on the first load that finds it and a list
never saved, `analytics.ts` migrates it, and removes it only after the server accepts a write, never
on a refusal. It never writes the key, and an installation that never ran the browser-only list
finds nothing under it. Removing the migration changes behaviour, and this document does not rule on
it. Cases in `web/src/screens/AnalyticsScreen.test.tsx` hold two client-only rules:

- **One write is in flight at a time**, because two mutations sharing a version make the reader's
  own second click look like another device's.
- **A row this version cannot read is kept and sent back**, because dropping it deletes it on every
  device at the next save.

**Goal figures come from the server.** `/api/goals` supplies each goal's target, current value,
remainder, status, percentage semantics, source line, required monthly work hours, monthly capacity
and whether it is exceeded. The client formats money and picks copy from closed dictionaries. It
never derives a basis, progress, forecast, work-hours result or account total. The goal-unit and
progress-semantic formatters are exhaustive switches, so a wider server vocabulary is a type error,
not plausible fallback copy.

**Wire types come through `web/src/types.ts`, as types only.** Every wire shape there is an `export
type … from` of `backend/src/wire`, and the file declares nothing of its own but `TxFocus`. A field
renamed on the server is then a `tsc` error at every reader, never an `undefined` on a screen, and
`web/src/test/fixtures.ts` follows by the same derivation. Only the statement forms `import type`
and `export type` are allowed: a value import compiles, nothing erases it, and it bundles zod and
the wire module into the client with both suites green. No other file under `web/src` names the
backend path.

`web/src/types.test.ts` holds both rules over the program the compiler builds from
`web/tsconfig.json`: everything it compiles outside `node_modules` and `backend/`, config files and
resolved imports included. It resolves each specifier as the compiler does, so a `paths` or
`baseUrl` mapping, a `rootDirs` overlay, a relay outside `web/src/` and an unexpected extension all
show up as the file they reach. What only vite resolves is not walked. A tsconfig case refuses
`paths` and `baseUrl` outright, since either lets a bare name reach `backend/` without `types.ts`
saying where it goes, and refuses a `paths` mapping to a second zod. A `resolve.alias` in
`web/vite.config.ts` is no way in on its own, because `tsc` stops at `TS2307` first. With an ambient
`declare module` beside it, it is one, and the walk does not see that.

The client's typecheck compiles the wire module and finds `zod` in `backend/node_modules`. So `npm
run setup` installs `backend/` before it builds `web/`, and the `web` job in
`.github/workflows/ci.yml` installs `backend/` before its typecheck. Reversed, the typecheck fails
with `TS2307`.

**Client copies of wire constants are pinned by type, both ways; their order is the client's.** A
value import is refused, so `analytics.ts` copies the chart bounds and the id charset and `api.ts`
the error cap, each written `satisfies typeof` the wire's export. They must equal the server's, not
merely fit inside them. The charts route refuses a whole list: a lower client bound truncates what
the server would take, a higher one composes lists it refuses, and a client minting ids from a
charset the route has narrowed is refused on every save. The client shows the whole diagnostic
budget, because the importer orders a refusal's clauses assuming all of it is read, and a smaller
cap would cut the last one.

Vocabularies are held twice, as the wire's unions and as exhaustive presentation records: chart
kinds, measures, breakdowns and ranges in `analytics.ts`; goal types, bases, income scopes and
statuses in the Goals presentation model; income-source kinds in
`web/src/components/IncomeSourcesBlock.tsx`. Each record is written `satisfies` a `Record` over the
union, never annotated as one, and pickers derive their options from it. A missing or an extra
member is then a compile error wherever the literal sits; an annotation catches an extra member only
on a fresh literal.

A client narrower than the wire fails differently per vocabulary. An unknown chart kind is refused
by `parseChart`, kept as unreadable by `chartEntry`, sent back verbatim by `entryWire` and named on
the screen. An unknown goal type has no tile and cannot be created. An unknown income-source kind is
a label read by a missing key, which throws in render and, with no error boundary in this app, takes
the whole app down. A client wider than the wire composes lists nobody can save.

Every pin assumes the wire's export has a literal type. `web/src/types.test.ts` checks that under
`tsc`: each client constant equals its export's type, and each union equals its record's keys. A
constant widened to `number`, or a tuple that lost its `as const`, fails there instead of silencing
every pin. Order is not held. The wire's zod enums carry no order, and a picker follows its record
literal's key order, which the language keeps for every key but an array index: a vocabulary member
spelled as a bare integer would reorder.

**The checks here that read source as text** (`copy.test.ts`, `tokens.test.ts` and `types.test.ts`
among them) resolve their root from `import.meta.url`, unlike the backend's checks, which use
`process.cwd()`. The two idioms differ on purpose; `backend/test/SPEC.md` gives the reason under
*Boundary*.

**`tokens.test.ts` refuses a design token no product code reads, and a `var()` with no
declaration**, because CSS fails silently at both ends. It skips tests and fixtures, so an assertion
cannot keep a role alive. It follows aliases from styling rules rather than accepting an island of
declarations, and resolves against the stylesheets and the palettes `theme.tsx` publishes. It proves
nothing about the cascade, contrast or layout; those need a browser.

**`API_BASE` is empty** because the API is always this page's own origin: `web/vite.config.ts`
proxies `/api` under the dev server, and `npm start` serves the client from the backend. No request
is cross-origin.

## Invariants

**Support is an ordinary category in the picker, the filters and the rules; its income treatment is
the API's.** The client says Support counts as income but not as own earnings, and hides the
income-source picker for incoming Support, because the category already makes the money external.
Signs, refunds and transfers keep their usual meaning. A change into or out of Support re-reads the
whole list, as a rule apply does: the server recomputes every transfer pair on that change, so the
partner leg on another account may move too, and a splice would fix only the touched row. The detail
stays open on the updated row either way.

**The word for money somebody else gives you has several copies across both packages, and nothing
keeps them in step.** Here: `support` in `CATEGORY_LABELS` (picker, filter, rule captions,
Transactions list); the explaining prose in the Goals cards, the income sources block and the
Transactions detail hint; the *Support* kind name in `IncomeSourcesBlock`. In the backend: the label
`seedDefaults` gives the seeded external source in `backend/src/db/index.ts`, and the refusal
`backend/src/app.ts` sends when a Support row is given another income source, which the client
prints as it comes. No check compares them.

The seeded label belongs to the person, who may rename it. The source the server derives from the
Support category works the other way: the summary answers its id as its label, and
`incomeSourceLabel` in `categories.ts` turns a `category:` id into the dictionary's word, so
renaming the category renames the source. On the default seed the two words coincide, so a period
with income under both draws two slices with one name. The donut and the ranking tell them apart by
colour and figure, the radar only by position and figure. The Transactions list badges a row from an
external catalogue source with its label and gives a derived-source row no badge, since its category
already says what the money is.

**An account delete answers with what it removed: transactions, imports and documents.** For a
hidden account that legitimately differs from the preview. A document there is a removed import that
claimed a stored file, counted whether or not its bytes were still on disk. The preview counts a
hidden account through the server's import totals, because the transactions endpoint answers nothing
for one; the delete counts rows by account id. Transfer rules are removed too and are not counted.

## Keeping hidden screens current

Every screen stays mounted while hidden and keeps what it last read. A write that changes what other
screens show bumps a counter in the Shell, and every mounted reader re-reads on it.

**`dataRevision`** is for writes that change rows or their classification. On it the Overview
re-reads its rows, figures and account list (a balance is the sum of its account's rows),
Transactions its rows and source catalog, Analytics its chart data and accounts, Goals its progress,
and Settings its recurring groups. These writes bump it:

- a confirmed import; an upload that only stages rows bumps nothing;
- deleting an import, from either screen that opens `ImportHistory`, through its `onChanged`;
- deleting, hiding or unhiding an account, because the server leaves a hidden account's rows out of
  every read;
- an income-source write, because a source pattern can break a transfer pair and turn the remaining
  expense into a recurring payment;
- a financial setup save whose answer carries owner names other than the ones the block held, echoed
  or not, because the server reclassifies transfers before it answers. An answer that changed
  nothing bumps nothing.

**`accountsRevision`** is for writes that change the account list and no rows: creating or renaming
an account. Transactions and Analytics re-read their account lists on both counters, since a delete
or a hide changes the list too, and Goals on this one, because a goal's source line names accounts.
`dataRevision` would be wrong here: it closes an open rule editor on Transactions and re-reads
figures that did not move. An account created from the import panel has no rows yet, so it bumps
only `accountsRevision`, and the Overview's own reload puts it on the rail.

An income-source write bumps as soon as it succeeds, so a failed follow-up catalog read cannot
suppress it. Transactions clears its source catalog for the reload and shows a failed read with a
retry, rather than pairing new classifications with stale names. Settings clears its catalog after a
committed write, so a failed re-read offers Retry, not actions on stale rows. Revision-driven loads
are latest-request-wins.

**A new base currency** arrives with every converted amount reset and refilled in the background.
The financial setup block polls `GET /api/conversion` until no refill runs, then bumps
`dataRevision` once, covering the names too. A reader re-read in the gap would show an empty
recurring list or a zero total as data. A names-only save during that watch leaves the bump to it. A
refill that stopped with rows unconverted is reported beside the form, with how many, because
stopping is not finishing. A status that cannot be read shows a Retry and bumps nothing. The watch
ends with the block, so no poll outlives its screen.

## The arithmetic a screen does on the server's figures

`toCents` is where money goes before it is added or subtracted. Nothing enforces this, and it is
exported because the rule reaches past its module. A server amount is an integer number of cents
divided by a hundred, so it arrives as a double near the figure, and sums keep the residue: a zero
base becomes a tiny one, and a percentage of it means nothing. So `accounts.ts` compares in cents,
`analytics.ts` sums integers and divides once, and `spendRing` in `categories.ts` calls `toCents`
rather than keeping a copy.

`monthOf`, `fmtDay` and `fmtMonthKey` split a calendar key as text and never make an instant. The
server buckets months with `SUBSTR` over the stored ISO date in `backend/src/db/index.ts`, and a
local `Date` disagrees with it west of UTC: on the first of the month for a month key, and always
for a statement's day, which is a calendar day, not a moment. `fmtWeekday` takes a real instant on
purpose, today where the reader is, and uses the local getters.

`monthEnd` gives a month's last day in UTC. `accountSummary` and `accountMonths` in `api.ts` send
that calendar day as `to`, which the summary routes in `backend/src/app.ts` and the transaction
query in `backend/src/db/index.ts` pad to the end of the day. A `to` one day short silently drops
the last day from every figure, and a month without its last day still looks like a month.

`net` means two things. `SeriesPoint.net` is income minus expenses, which a transfer between the
reader's own accounts must not move. `AccountMonthTotals.net` sums every row, transfers included:
the account months query in `backend/src/db/index.ts` filters transfers inside income and expenses
only. That is why the months add up to the balance, and why `balanceChange` can take today's balance
less the month's `net` as the opening balance: no balance history is stored, and the balance is the
sum of all rows, by the rule `recalcAccountBalanceFromTransactions` follows. A restore copies the
stored balance as the backup carries it, so this needs a backup whose balance matches its rows.
`MonthFlows` has no `net`, so `seriesFromMonths` cannot read the wrong one.

`MONTH_WINDOWS` is the Overview's toggle, in the order written. `LONGEST_WINDOW` is derived from it
because it sets how far back the Overview fetches: a window added to the array must not leave the
fetch one step short.

## What a chart is, and where its numbers come from

`CHART_KINDS` sorts kinds into `series` charts, which plot measures across ticks, and `share`
charts, which plot one period's parts against each other. The two take different data, ask different
endpoints and are configured by different questions. `chartKind` is the one answer the wizard and
the loader both read.

**Three fields of `Chart` mean something on the client.** The title is the reader's: the wizard
suggests one until the reader types, and never overwrites a typed one. `metrics` may be empty
between choices, since the chips set no minimum; such a series chart cannot be saved, and
`ChartPlot` says so on the plot. `accountId: null` is every account together, as the summary
endpoints answer without an id. An id naming no account is not that: `chartData.ts` refuses it
rather than draw the whole under one account's title.

`useChartData` is the one seam between a chart and the server. `analytics.ts` holds the model and
the arithmetic, never fetches or touches React, and takes `today` as an argument, so every series
can be tested against a fixed date. `chartData.ts` turns a `Chart` into requests and the answers
into drawable data. Components draw the result and may total what they print.

The account choice decides the body. With no account, `/api/summary` and `/api/summary/months`
answer the whole, converted into the base currency. With an `accountId` they answer that account's
rows in its own currency, unconverted. Both arms follow one rule in `backend/src/db/index.ts`: a
transfer between the reader's own accounts stays out of income and expenses (through `scopeSql`'s
filter or inside the sums), and a refund reduces the expenses of the period it landed in. Only the
unit differs, so `currency` comes from the body that answered, never from the accounts list.

`useChartData` tells apart three states of the account list, and the screen decides which holds.
`accounts` is null while `web/src/screens/AnalyticsScreen.tsx` has no list: before its first read
lands, or after a read failed. That differs from "read, and this account is not in it": with both as
an empty array, every per-account chart would say its account is gone for the length of one request.
`accountsError` marks the failure; without it a per-account card would wait for a request that never
comes, with nothing to press. So a per-account chart waits only while the list may still arrive. A
chart of every account never waits for the list, or each such card would fetch twice. `data` is
cleared before every load, so a card never labels old points with the new range's months.

The loaders get the account id, never the account object, which `useChartData` resolves only to
refuse a missing one; a chart's currency is the body's. Nothing is lost: `backend/src/app.ts`
refuses a currency change once an account holds a row or has an import waiting, so an account whose
currency can still change has nothing on a chart for a stale tab to mislabel.

`loadShare` makes one request per window for a comparative kind, in both arms. `/api/summary`
answers one split for the range it is given: a doubled window comes back with both periods added
together, nothing here can take the earlier half back out, and every category's `before` would equal
its `now`.

`drawnShares`, built on `positiveShares`, decides in `analytics.ts` which parts a kind draws, so the
files drawing a chart cannot disagree about what it is of. Otherwise a card can sum every slice
while its donut sums only the positive ones, and one refunded category puts two totals on one card.
A refund can push a category negative, purchase in an earlier period and refund in this one, and
that is the honest figure: a ranking has a baseline and prints it, a donut or a radar has no
negative sector and drops it. `SharePoint.key` is the backend's slug or the income source's id.
`ChartPlot` uses it as the React key, and as the colour key only for a category breakdown, never for
a source id that happens to equal a slug.

`parseChart` reads a stored row field by field and answers null for a shape it does not recognise,
because a throw would take the screen down on first paint, and a row can come from an older client,
a hand-edited backup or a wider vocabulary. `chartEntry` keeps such a row as unreadable, for the
reason under *Boundary*. `parseChart` accepts an empty `id`. A chart's `id` in
`backend/src/db/schema.ts` is a primary key with no check on its content, and `restoreBackup` in
`backend/src/db/index.ts` checks column types without zod, so a restore can bring in an empty id or
an over-long title that the next GET carries out and the PUT route refuses to take back. So
`normaliseForSave` trims the list to the route's bounds on every save, not only in the migration.
Otherwise one such row would get the reader's whole list refused for good, over content they never
typed.

`parseChartList` in `api.ts` parses both the 200 and the 409 of the charts route, which carry the
same `version` and `charts` pair in `backend/src/app.ts`. So `ChartsStaleError` carries the current
list, and a client refused as stale re-syncs from the refusal itself, with the same code that reads.

`ChartPlot` holds no state and fetches nothing, so `ChartWizard`'s preview is exactly the chart the
card will draw, from the reader's own data: a range is easier to judge from its plot than from its
name. State or a fetch there would run twice, once in the preview and once in the card.

`ChartCard` shows the comparison window beside the plot where there is one, and a unit the response
lacks stays unavailable rather than borrowed from the account list. The dates shown travel with the
loaded numbers, so a rename after a month rollover cannot relabel old figures as a new window.

`ChartControls` holds a chart's actions and their safe confirmation, as one component for the
selected chart's context and for the desktop strip; `AnalyticsScreen` owns every mutation. On a
narrow screen `AnalyticsScreen` picks the chart with a labelled selector above the plot, not a
second bottom dock, and primary navigation stays separate. The action group closes when focus leaves
it, without taking the new focus, so two groups never compete for Escape. Strip controls under a
coarse pointer use the shared touch size.

`ChartCard`, `AccountFlows` and `SpendingByCategory` hide the plot from screen readers and carry its
numbers in a visually hidden table, because the SVG is unreadable. Their tests hold that; nothing
holds a future chart to it, and every future chart a reader reads owes the pair. `ChartWizard`'s
preview has no table, so its figures reach a screen reader only once the chart is saved. Hidden
plots turn off Recharts' keyboard layer, and a pie's root group leaves the Tab order; otherwise
focus targets appear under the hidden plot and break traversal in an editor, even inside a dialog
that contains focus. Tooltips and the tables do not depend on that layer.

`isAnimationActive` is false on every series in `ChartPlot`, `AccountFlows` and
`SpendingByCategory`, and nothing enforces it. Screens stay mounted, so a chart may first render
hidden, and an animation started there freezes on an arbitrary frame. That is also why reduced
motion needs no chart rule.

`DOTTED_UP_TO` is declared in both `AccountFlows` and `ChartPlot`, and nothing keeps the two equal.
The rule sits beside `ChartPlot`'s copy.

`ChartWizard` keeps `metrics` and `breakdown` in the draft across a change of shape, so a donut
switched to a line and back keeps both; `chartSchema` in `backend/src/app.ts` accepts both for any
kind and sets no minimum on `metrics`. A failed account read stays distinct from an unresolved or a
missing account choice. The preview's waiting and refusal stay inside the preview, and the builder
frame owns the main scroll.

`AnalyticsScreen` draws only the reader's charts, none of the app's choosing, one at a time: the
reader asked one question of each chart, and in a grid its answer would have to be found among the
rest.

`loadAccounts` in `AnalyticsScreen` reads the account list, hidden accounts included, and hands it
to the card and to `ChartWizard`, because the answer is the same for every chart and the card
remounts whenever the chart changes. It re-reads on both revisions and on its own Retry, keeping the
old list until the new one lands.

## Where the reader is

`useUrl` reads where the reader is from the URL, the only store. A key can have several readers, and
Back must move them all at once. A `useState` cannot hear `popstate`, and a copy per reader is
copies that disagree, with no answer to Back, Reload or a copied link. With `useSyncExternalStore`
every reader subscribes to the URL, none is wired to another, and a fact no reader owns is read from
one place.

`read` returns the same object for an unchanged address, because `useSyncExternalStore` compares
snapshots by identity and a fresh object re-renders forever. The address compared is the whole
published one, path and fragment included, though `AppUrl` exposes only its query keys: hash
navigation must refresh the real link targets without resetting a draft whose keys did not change.
The store hears both `popstate` and `hashchange`. A trailing hash notification that a traversal
already handled, or that its accepted write made stale, cannot stage another guard or override that
write. Equal URLs are never taken for the same history entry.

`urlFor` is exported because navigation is anchors, and `Shell.tsx` builds every `href` from it. A
second address builder would fail invisibly, since a click never uses the `href`: only the status
bar, a copied link and a middle-clicked tab would be wrong.

`AppUrl` validates nothing; each reader validates the keys it reads. `tabOf` in `Shell.tsx` folds an
unknown `screen` to the Overview, `web/src/screens/OverviewScreen.tsx` reads `panel` as import,
history or nothing, and account and chart ids name things `url.ts` knows nothing about. The URL says
where the reader was, and the reader's data says whether that place still exists: a missing chart
falls back to the first chart, as a missing `account` does to the first account.

`Shell` renders every section, Import and Settings included, as a real link to `urlFor`'s address
for its patch. `navigate` takes only a primary click with no modifier for the app and returns before
`preventDefault` otherwise, so every other click is the browser's. As measured in Chromium on Linux,
Ctrl+click and Shift+click open the address in a new page and leave the current one where it was.

`patchFor` in `Shell` sets `panel` to nothing on each tab link and on Settings, which closes an open
panel when the reader leaves its screen that way; the Import link has a patch of its own. That is
why `SettingsScreen` keeps its import history in the URL, as `panel` set to `history`, rather than
in state. Back or Forward to an entry with a panel reopens it.

`AppUrl` holds where the reader is, not how a screen is set up. The Overview's chart window and its
hidden-accounts switch are component state on purpose: a link carrying them would override the setup
of whoever opens it.

`useEditorSession` guards an editor's unsaved changes against opening values its caller owns, and
each caller chooses its own comparison. Immediate transaction writes take no draft and no global
Save. Unlike a pending save of a draft, an immediate write or a read does not hold navigation and
settles behind the hidden screen, and a confirmed or optimistic completion bypasses only its own
guard.

`registerNavigationGuard` stages an app navigation before any history write or accepted side effect,
and freezes the published location while a traversal is blocked, so an unrelated render cannot reset
an editor from the address bar. Native entry identities are resolved against the browser's live
entry list before an offset is computed, because pruning can rebase positions after a snapshot.
Every open editor's guard is asked, newest first, so no draft is left unguarded.

`replace` is for a value the app derived, not one the reader chose. It leaves no entry, or Back
would land on the address the app was correcting and correct it again.

Only an entry whose offset nothing can identify is reported as unverified: a restore with a known
offset is already on its way back, and a warning about it would be false a frame later. Accepting
another browser destination drops a queued URL change but never undoes a confirmed server write.
Without a usable source identity no automatic return is promised. When a goal's address update has
to wait, its list still refreshes at once.

Leaving the document shows the browser's native prompt while an editor is dirty, and also while its
pending save holds navigation. Nothing promises recovery.

## The sentences a person reads

`CATEGORY_LABELS` and `IMPORT_STATUS_LABELS` turn slugs into words, and nothing is sent back through
them. No code branches on an `IMPORT_STATUS_LABELS` label, so one can change without a slug moving.

`categoryRuleCaption` states the rule and a transaction count, never which category rows ended up
in, because two backend facts would make that false. `overridden` in `backend/src/db/index.ts`
counts every hand-set row whatever its value. And a newer overlapping rule keeps the rows this one
matched: `makeCategoryRuleMatcher` in `backend/src/classify.ts` takes the first match over rules
listed newest first, and saving a rule again, through `applyPreviewedCategoryRule` or
`addCategoryRule`, changes only its category and leaves `createdAt` alone.

`readAsSentence` covers the wire's `kind` union and still answers a sentence in its default arm
instead of throwing. A build of this app names only arms the server declares, but a body can come
from a server of another version, since the client is built and the server runs from source, or
through a proxy. The app has no error boundary, and the confirmation card is the only place a staged
import is confirmed or discarded (nothing enforces that), so a throw there would take the app down
with the import still staged.

`GENERIC_PRESET_TITLE` is a prefix of the server's title for the generic reader, deliberately not
equal to it. `backend/test/upload.test.ts` pins that title to start with this string and names the
constant, so a future producer of the title must keep the prefix, and the chip with the long title
and the sentence with the short one name the same reader.

`rowCount` repeats the helper of the same name in `backend/src/providers/statement.ts` on purpose:
neither side of the wire can import the other, and a row count should read alike in an importer's
refusal and on a screen. Each copy breaks only by an edit to itself, so two copies are safe.

`balanceClaim` lets the running-balance sentence claim the run, never a complete statement.
`checkSheet` in `backend/src/providers/statement.ts` derives both ends from the rows it read, so a
row lost from either end moves that end instead of breaking the run, and nothing here can tell. A
PDF prints its own balances, and there the rows are checked against them.

`CsvImport`'s confirmed panel and re-upload card and `ImportHistory` print how many rows did not
import, without a cause. `rows_rejected` sums the unreadable, status-filtered and no-money rows (the
`DropKind` buckets in `backend/src/providers/statement.ts`) without saying which. The breakdown is
on the summary card before Confirm; a cause printed afterwards would be a claim about rows none of
the three can see.

`CsvImport`'s confirmed, discarded and duplicate outcomes keep the source and destination beside the
answer, and staged problems show without a disclosure. The sentence saying how the file was read
comes before the review's figures, because it qualifies them. The balance pair's claim stays in the
details, since a continuous run does not prove the statement complete.

A failed confirmation is unverified: the review points the person to the import history or the
transactions to check, and never claims that leaving discards the import. A confirmation that
inserted nothing leaves the created-account notice standing, because the account was written before
the upload. A successful read, confirmation or discard focuses the new heading, outside the Tab
order, so the answer is not lost below the setup.

`CsvImport`'s re-upload card and the note `deduplicated` gates in `ImportHistory` never say where a
file's rows are now. `import_id` names only the first writer (*Import provenance, and what an
import's row promises* in `backend/src/db/SPEC.md`), so deleting an earlier import removes rows a
later file also contained, while that later import stays committed and its file still answers
`duplicate`. Nothing on the wire would tell the card. It states only the earlier import's own
counts, written at staging or copied in by a restore. The note is gated on a count `listImports`
takes at read time, and claims nothing about where the rows are.

The card's count of the file's rows is the duplicate answer's `total`, accepted plus dropped. For an
import this code staged, that equals the rows the reader handed `mapAndStore` in
`backend/src/providers/statement.ts`, which refuses a read whose counts do not add up. Rows never
handed over are in neither count, so the card can count fewer rows than the file has, as the
confirmed panel's heading does. They include rows on a workbook's other sheets (`readXlsx` in
`backend/src/providers/xlsx.ts` reads one, and the import records nothing of the rest) and the dated
lines of a PDF table its template marks `collect: false`, such as a Revolut statement's pending
section, which `readPdf` in `backend/src/providers/pdf.ts` drops and no screen mentions.
`restoreBackup` in `backend/src/db/index.ts` copies both counts unchecked, so for a restored import
the sum is only what the backup says.

`drops` in `CsvImport` leaves filtered rows out of the summary card's sentences, because the
backend's own line in `problems` already counts them and names the statuses that filtered them, as
many as fit and then a count. A second count would describe the same rows twice.

`IncomeSourcesBlock`'s pattern hint states the word floor `makeSourceMatcher` in
`backend/src/classify.ts` applies, and nothing ties the two together, as with `categoryRuleCaption`.
A pattern with too few long-enough words is stored and tags nothing, so the hint and the example in
the editor field must follow the floor. In the source editor, refusals and a pending save stay in
the action region, and focus after a committed write never overrides a place the reader has moved it
to.

## The palette, and what leaves the page

Dark is the initial theme. A saved choice wins, and a saved value no longer offered opens on dark.
One toggle switches between dark and light, and no mode follows the OS. It sits at the foot of the
desktop sidebar and in the mobile top bar; the local-storage indicator stays in the sidebar. Where
the theme is kept is under *Boundary*.

`ink` publishes the palette a second time. The custom properties `ThemeProvider` sets on the
document root are the styling truth, and `ink` exists because recharts needs real colour strings.
`theme.tsx` publishes both together.

- An action's or a selected state's foreground belongs to its ground, not to an inherited text role.
- Brand marks the product, success an outcome, income a financial series; favourable and
  unfavourable interpret a comparison whose direction the caller supplies. The roles stay
  independent even where hues are close.
- A role must reach product styling or a chart reader, not survive only as a published property.
- Control boundaries and focus have their own contrasting roles, and focus feedback is more than a
  changed border.

`TOOLTIP_CHIP` gives each ground a chart sits on one value: a fill and the two colours on it. A
ground is named after its fill's `Ink` key, so nothing says twice what colour a card is, and a
ground without a chip does not compile. Each caller tells `ChartPlot` whether it is on a card or in
the wizard's page preview. The chip's fill is `raised`, a step off each ground on purpose: the
border makes the box, not the fill. A tooltip never takes the series' colours.
`chartTooltip.test.ts` pins the tightest live fill-on-ground pair in each palette, and the border's
separation, at the measured values rather than a floor, and fails when a recorded figure stops
matching.

`tooltipProps` and the arithmetic in `analytics.ts` live in modules without JSX, because in jsdom a
chart has no size: recharts draws nothing there, no tooltip either, and a mounted chart allows no
assertion. `unit` cases test them against both palettes or a fixed date. The attributes recharts
reads off a datum by name and never checks are pinned as text by `chartTooltip.test.ts`, as a list,
not as a boundary.

`saveBlob` is the one place where bytes from the API become a file. Its single `URL.createObjectURL`
call takes a `Blob` and nothing else, no `Response` and no path, so a body nobody checked cannot
become a file. It is the package's only object URL; nothing enforces that.

`safeFilename` is the server's `attachmentDisposition` done on the client: the reader's name, then
the id-derived one, then a constant. `MAX_FILENAME_CHARS` copies the cap `cleanName` in
`backend/src/app.ts` slices at, so both ends cut a name alike, but no type or test pins it. The
cleaning differs on purpose: nothing here is percent-encoded, so the lone-surrogate rule protects
nothing, and a `download` attribute is UTF-8 with no ASCII half.

`ChartPlot` colours a series by the `Ink` key its `METRICS` entry names. On Analytics expenses use
neutral ink, income keeps its own role, and Net is not automatically favourable; the Overview's
expense series keep their own encoding. Income series and their legend marks use the income role,
apart from the action and success colours. A category breakdown always uses `categoryColor` by slug,
with the neutral fallback, never a hue that depends on rank. An income-source breakdown uses a
labelled chart-local palette, even when a source id equals a slug: the breakdown decides meaning,
not string membership. Metric groups use spacing, not nested surfaces, and keep their full labels.
Clipped wrappers contain a table's width without changing the plot's accessible rows.

`ChartPlot` marks a donut part with the round `.dot` and a series with the square `.swatch`.
Category dots follow the slug, not the rank. The Overview's aggregate remainder uses a square
swatch, so it does not read as another named category, and series and period legends use square
markers with their own labels.

## Presentation foundations

`web/src/styles/tokens.css` owns the type, spacing, control, radius, motion and measure roles, and
no colour: colour is the palette's. Text roles keep orientation, reading, labels, help and metadata
apart from comparable financial numbers, and numeric styling never changes signs or formatting.
Inputs stay readable on narrow screens, and text and controls may grow with the reader's text size.

`screen-inner` sets the outer page anchor and the gutters at every screen's root. The wide, normal
and narrow measures limit width without centring inner regions on their own. Settings uses the
normal measure until each heading fits beside its section, then the wide one, with a narrower
financial form inside either. The Overview and Goals use the wide measure. The import setup widens
only while its guide fits beside the form. Existing scoped compositions keep their own treatment
rather than gain a new wrapper. Scrolling, hiding inactive screens and the navigation's safe area
are the Shell's.

Grouped surfaces stay flat and nest by spacing. Dialogs have their own radius, and Analytics
surfaces share the grouped one. Focus is visible on the actual ground. Disabled and locked actions
use a readable neutral pair and a dashed border, not the cursor or faded text, and a pending action
keeps that look. Reduced motion never depends on a transition to reach the final state. In forced
colours selection draws a ring inside the control, apart from its fill and border, so selecting
never resizes it or moves its neighbours. Custom switches use system-colour track and thumb pairs
and opt out of forced adjustment, so the thumb cannot vanish into the track.

**A financial value keeps its sign and its currency attached.** Too wide for its place, it scrolls
inside its own box instead of shrinking or splitting, and on a narrow screen it may take a line of
its own. The scroll box is start-aligned around a max-content value that aligns right only within
its own width, so a wide amount never starts outside the scroll range. The exception is the centre
of the Overview's spending ring, which cannot scroll: a long total shrinks there and may wrap, with
the currency on its own line.

**Every screen, a new one included, owes the reader honest reads.** A pending or failed read never
looks like an empty result: waiting, a refusal and a real empty answer are told apart, and each
stays in the region it fills. A list refreshed after a write may stay visible, marked as updating. A
failed refresh keeps the old data beside its refusal and a Retry. The explicit Retry of the import
history, of the recurring payments and of the income-source catalog moves focus to a stable heading
before it removes itself; automatic reads move no focus.

A pending `Button` adds its indicator without changing its size, and choice controls share one
selected-state treatment. On a narrow screen `FormActions` gives completion its own row without
changing the keyboard order. Back uses the `tertiary` variant everywhere. A `Notice`'s tone
establishes neither success, emptiness nor availability.

## Screens

**Navigation** uses the same links in the desktop sidebar and the mobile bar, where Settings takes
Import's place. Screens stay mounted so filters survive navigation.

**Overview** keeps each account's own currency, and each card names its period from its own
response. The recent list implies no balance history and no update time. Balance and ordinary
expenses are neutral; income and comparisons use their own roles. The spending ring draws only
positive values while its legend keeps the server's net figures; `spendRing` in `categories.ts` is
where the two part ways, so both come from one function, and `categories.test.ts` holds them apart
on a fixture whose tail nets to nothing.

On a wide screen the Overview is one grid with named areas: balance over spending, flows over recent
transactions. Areas, not a wrapper per column, keep the cards in the single column's order, which is
the keyboard's. The balance card is never stretched, and the two lower cards end on one edge. On a
tablet the spending card sets the plot and its legend side by side without changing the reading
order. The chart tables sit in clipped wrappers, because a clipped table still widens a narrow page.
Recent transactions reflow into records on a narrow screen, and the account rail scrolls to the
selected account. An account's import button opens the staged flow, where the destination is chosen
and confirmed: the account being viewed is no evidence that the next statement is its.

**Transactions** category rules match a description substring across all accounts, hidden ones
included. Rule actions are filled or outlined buttons; *Back to transaction* is navigation, not a
rule action, and is tertiary like every Back. The initial category-rule pattern is the server's
display title, so a bank's value-date label does not narrow the group. A group change returns to the
detail with focus restored. Rows have no per-row buttons, and their context wraps before figures
shrink. An immediate edit announces pending and refusal beside the classification responsible, with
no global Save. A rule preview is the server's, over the whole history, never a filter over the
loaded rows, which are filtered and capped. It gives its own refresh guidance after a refusal.

**Goals**: an obsolete response cannot clear a goal list's *Updating* status for a newer request,
and a pending delete blocks navigation through its own session. Edit and Delete carry the goal's
name in their accessible names, so narrow layouts and assistive action lists keep the card's
context, and they belong to the goal, not its headline. Status guidance names an action only for a
status with one cause: `needs-setup` can name essential costs, while `not-enough-data` stays
neutral, because missing history or an unconverted row can cause it. Ordinary figures are neutral,
with their own favourable and over-limit roles. `GoalEditor` takes its correction targets from its
existing validation predicates, and an API diagnostic without a field keeps the full diagnostic
budget. Costs and account choices use headings and separators, not nested scroll areas.

**Settings** sections are separated by headings and separators, not nested cards, and financial text
has a narrower measure. The API address sits in a closed *Advanced* disclosure, because it
identifies the page's local REST API and is not a preference. Financial setup leaves validation and
recalculation to the server. The recurring list shows the server's monthly total without recomputing
it, with category markers from the palette, not guessed merchants. Groups are followed by the
server's `key`, not their description, which is the newest spelling and changes between reads. A
refusal on an excluded row shows outside the disclosure. After a recurring write, focus goes to the
section heading only when it was lost or is still inside the card.

## Accounts and statements, as the client handles them

`CsvImport` reads the account list with no argument and filters nothing itself. The server leaves
hidden accounts out of that list and `POST /api/imports` refuses their ids, so a filter here would
show the same list while moving the decision away from the layer that holds it. An account is
created by its own request, never by an upload (the route refuses `accountName` and `currency`), so
the create arm makes the account before the file is uploaded. What the import's writes refresh is
under *Keeping hidden screens current*.

`ImportHistory`, when given an `account`, and `AccountDialog`'s delete preview ask `api.imports` by
account id, never by `accountName`: the server filters by id, and an import row's name is the
account's name at staging, which a rename leaves behind. The caller supplies the history's return
label, and the workspace-wide history does not pose as an account's panel.

`ImportHistory` gives a record's source the full width before placing actions on a narrow screen.
Deleting a file needs no readable document claim, because unclaimed bytes may still need removing.
The removal confirmation names the source. Removal keeps its focus-recovery intent through any
retry, and an explicit Retry takes the heading first.

`AccountDialog` uses the shared Sheet frame for every step, and the full account name qualifies the
decision even where the rail shortens it. A pending action announces its write without implying it
was saved. Refusals stay in the action region, not below scrolling consequences, so a focused
completion control never hides its failure; the history remedy stays there too, its control not
moving when the answer arrives. History stays the remedy for any server refusal, without parsing its
text or changing what the delete covers.

`AccountDialog`'s delete gate compares the typed name trimmed and case-insensitively, because the
server trims names and `accounts_name_unique` in `backend/src/db/schema.ts` is on the lower-cased
name. Demanding the capitals back would refuse a name the server treats as identical.

`COUNT_LIMIT` is what `AccountDialog`'s delete preview asks the transactions endpoint for. The
endpoint answers a bare list that says nothing about a cut, so the preview asks for more than any
plausible count and says so when the answer comes back full. A server capping the limit below
`COUNT_LIMIT` would make a cut list read as a whole count.

`AccountTabs` gets the accounts in the rail's order: the server's, by provider and then by name,
with hidden accounts last when shown. A rename can therefore carry the selected account to another
page on the next load, which is the case the strip's paging effect follows.

## What the shared controls promise

In a `Sheet`, a control that focus reaches by a wrap at a boundary, or by a recovery of lost focus,
is also scrolled into view, because in single-flow mode even a header or footer control can be off
screen. The income-source refresh restores focus by its own asynchronous fallback rather than
compete with the `Sheet`'s generic restore.

The shared frame has one scrolling body with optional header and action regions, and the fields and
previews inside add no scroll areas of their own. Whether header and actions must rejoin the
scrolling flow is measured from real text and control geometry, so enlarged text counts. *Keep
editing* brings the focused control into view without resetting its caret. The test harness's resize
stub is neither optional nor evidence of layout: tests supply the geometry and the notifications.

The Shell drives `hidden` and `ScreenShown` from one value, so a screen's `hidden` and what its
sheets are told cannot differ. A filter change moves no focus. `useDismiss` is the one
Escape-and-outside-press seam for lightweight popovers. It does not replay a popover's opening focus
when its screen or the history returns, since that focus is the Shell's.

**On Settings, a control that would turn disabled while it holds focus is `aria-disabled` instead
and ignores a press, and a field being sent is read-only.** `Button`'s locked state and `Chips`'
`locked` serve the same rule elsewhere. A browser drops focus from a control disabled under it, a
refusal would hand focus back to nothing, and inside a sheet the Tab trap would hold nothing. The
income-source form locks while its save is out, because the save already took its values and the
sheet that closes on success would drop an edit made meanwhile.

`aria-current` marks the current one of a set: the navigation's links, and the plain buttons of
`AccountTabs`' account strip and `ChartDock`'s chart strip. Neither strip is a tablist, which would
make it a composite widget with a roving tabindex nobody asked for. As measured, and enforced by
nothing, the product's markup carries no `role="tablist"`, `role="tab"`, `role="radio"`,
`type="radio"`, `role="menu"` or `role="menuitem"`.

`NavIcons` and `ChartGlyphs` draw in `currentColor` and are `aria-hidden`: inside a control that
carries its name in text, an announced drawing would repeat the name, and a drawing takes its colour
from the control around it.
