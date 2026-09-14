# web/src

Status: draft

What this package's source is for, where it stops, and the rules about it that no type and no test
holds. Everything already enforced beside the code it governs stays there: `AGENTS.md`'s *Platforms*,
*Invariants* and *Verification has a hole* carry the contract, the slug rule, the error budget and
what a green run does not cover, and the headers of `accounts.ts`, `api.ts`, `url.ts`, `theme.tsx`
and `web/src/test/setup.ts` carry the reasoning beside the code. The month arithmetic in particular
— the anchoring, the window, the interior gaps and what they mean for the month a figure is
compared against — is written in full in `accounts.ts`, which is where a reader of it is sent.
Nothing below repeats any of that.

## What this module owns

- **Every request the product makes**, composed in one module, `api.ts`, through one raw fetch
  rather than through an SDK.
- **The month arithmetic the server deliberately does not do.** The summary endpoints answer only
  the months an account has rows in, and two modules fill the rest in opposite directions —
  `accounts.ts` anchoring on the newest month with data and `analytics.ts` on the window the reader
  chose — each stating its whole rule in its own header, `windowMonths`' and `ticksOf`'.
- **The sentences.** The API answers slugs and this package holds the dictionaries that turn them
  into something a person reads, an unknown slug included.
- **The entry point.** The app is `web/index.html`, and it is the only page this package builds.

## Where the boundary runs

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
failed to sync, so `theme.tsx` writes it to `localStorage` and is the only module that writes browser
storage. The screen, the account, the open panel and the selected chart live in the query string and
are read back through `url.ts`, and that is not a crossing: the URL is where the reader *is*, not
something a second client needs to reach — a native client has its own screens and its own Back, and
a server that has had no user since the product became single-user would be minting per-user
interface state to hold it. Why it is the query and never the path is stated in `url.ts`'s header.
The rule is held by `web/src/types.test.ts`, which walks the program the compiler builds narrowed to
the product files — the tests and the harness in `web/src/test/` set aside, by the same cut the
coverage reading makes — and requires every reference to `localStorage`, `sessionStorage`,
`indexedDB` or `document.cookie` to sit in one of two files and to be the operations it names for
each: `theme.tsx` may read and write its key, `analytics.ts` may read and remove the legacy one, and
nothing else may reach storage at all. The list is EQUAL in both directions, so an entry nothing uses
reds as an added file does. What the walk cannot see, stated rather than closed: a string-keyed
access (`window['localStorage']`), the Cache API, `navigator.storage`, a service worker, a script in
`web/index.html`, which the compiler does not read, and a dependency that reaches storage on the
product's behalf — a persist middleware, a storage hook, a query-cache persister — where the
identifier never appears in product source.

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

**Which of the two goal modes a figure was computed in comes off the body.** `/api/independence`
answers the mode it actually used beside the mode that was asked for, and
`web/src/screens/IndependenceScreen.tsx` reads it rather than working it out. The rule it replaced
was the same expression written once here and once in `backend/src/independence.ts`, agreeing by
coincidence: either side moving put every heading, hint, legend and what-if label on the screen into
one mode while the threshold, the shortfall and the self-sufficiency figure were computed in the
other, with nothing red in either package. Re-deriving it on this side — from the requested mode and
the line-item total, or by comparing the active threshold against the two the body also carries —
restores exactly that. Reading the requested mode is a different question and stays: it is what
decides whether the minimum's line items and their add form are on screen, so the state that cannot
create its own first item does not exist.

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
premise that all of it is read, so a smaller cap deletes the clause it put last. The six
vocabularies are held twice on this side — as the wire's union types and as the def records a picker
renders, four in `analytics.ts` for the chart kinds, measures, breakdowns and ranges, one in
`web/src/screens/IndependenceScreen.tsx` for the goal modes and one in
`web/src/components/IncomeSourcesBlock.tsx` for the income source kinds — and each record is written
`satisfies` a `Record` over the wire's union, never annotated as one, with the array a picker
renders derived from it by `defs()`: a member the wire lacks and a wire member the record omits are
both compile errors whether or not the literal sits on the declaration, where an annotated record
holds the extra-member direction on a fresh literal alone. A client narrower than the door cannot
draw a kind the server accepts: `parseChart` refuses the row, `chartEntry` keeps it as unreadable,
`entryWire` sends it back verbatim, and the screen names it rather than drawing it; a goal mode it
lacks is a screen with no chip selected and no way to pick it, and an income source kind it lacks is
a label read off a record by a key that is not there, which throws inside render and takes the Goal
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
`web/src/styles/tokens.css` is the one place values two stylesheets had to agree on were pulled into
— and CSS fails silently at both ends: an unread declaration costs nothing, and a rule naming one
that does not exist takes the initial value rather than erroring. The check holds one direction
only; its own header says which and why the other needs three declaration sources modelled at once.

## The invariants no type and no test holds

**The word for money somebody else gives you is written twice, in two packages, and nothing holds
the two to each other.** This package says *support* in the Goal screen's hero, in the income
sources block beside it and in the Transactions detail sheet's hint. The second copy is one package
over, in the label `seedDefaults` gives the seeded external source in `backend/src/db/index.ts`. The
packages share no build, `copy.test.ts` walks this side looking for something else entirely, and no
check compares them — so either half can drift and every test in both packages stays green. A user
who has renamed theirs reads their own word instead, which is what the delete confirmation looks up
rather than writes out.

**The account delete's counts — transactions, imports, documents — are what the delete destroyed,
which for a hidden account is legitimately not what the panel previewed.** The preview counts a
hidden account by the server's total over its imports, because the transactions endpoint answers
nothing for one; the delete counts the rows carrying the account id. Transfer rules go too and are
not in the answer.
