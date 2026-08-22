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

- **Every request the product makes**, composed in one module, `api.ts`, the authentication routes
  included: they go through the same raw fetch as the finance routes rather than through an SDK.
- **The month arithmetic the server deliberately does not do.** The summary endpoints answer only
  the months an account has rows in, and two modules fill the rest in opposite directions —
  `accounts.ts` anchoring on the newest month with data and `analytics.ts` on the window the reader
  chose — each stating its whole rule in its own header, `windowMonths`' and `ticksOf`'.
- **The sentences.** The API answers slugs and this package holds the dictionaries that turn them
  into something a person reads, an unknown slug included.
- **The entry points.** The app is `web/index.html` and the public page is `web/landing.html`; the
  sources of the second are `web/src/landing/`.

## Where the boundary runs

**One module talks to the server.** `api.ts` is the only file in this package that calls `fetch`,
and no other transport appears anywhere in it — no `XMLHttpRequest`, no `EventSource`, no
`WebSocket`, no beacon. That is the boundary as measured, and **nothing enforces it**. The jsdom
harness replaces the global fetch and catches a request to a route no test declared, which is a
different rule: a second module fetching a route some test already declares is invisible to it, and
the `unit` project installs no stub at all.

**`web/src/landing/` imports no code from the rest of this package.** The palette is the one import
that crosses (`web/src/styles/tokens.css`); the bundles share the font and the palette and no code,
which `web/vite.config.ts` says of the build. Nothing holds it from this side.

**State that lives only in the browser, named crossing by crossing.** The theme choice is written to
`localStorage` by `theme.tsx`; the screen, the account, the open panel and the selected chart live in
the query string and are read back through `url.ts`. `AGENTS.md`'s *Platforms* states that no state
lives only in the browser, because the REST API and not this app is the contract a mobile client has
to reach. **Nothing enforces that, and each of those is a crossing of it as the code stands today.**
Which of them a product wants to keep — a theme is per-device by design — is an open question this
document does not answer.

**The chart list was the third of them and is not one any more.** It is read and written through
`api.ts` against the routes `backend/src/app.ts` serves over the table in `backend/src/db/schema.ts`,
so a chart follows a person to a second device. What is left of the browser copy is one read: the key
`analytics.ts` used to write is migrated into the workspace on the first load that finds one which has
never saved, and removed once that write is answered. Two things came with the move that are the
client's alone and are held by cases in `web/src/screens/AnalyticsScreen.test.tsx` rather than by any
type: **one write is in flight at a time**, because two mutations sharing a version make the reader's
own second click look like another device's; and **a row this version cannot read is kept and sent
back**, because dropping it deletes it from every device the next time anything is saved.

**`copy.test.ts` is this package's own check that reads source as text**, and it resolves its root
differently from the checks in the other package on purpose. `backend/test/SPEC.md` states that rule
and the reason for the divergence; it is not restated here.

## The invariants no type and no test holds

**A check in the other package reads `api.ts` as source and finds its error-budget cap by name.**
`backend/test/error-budget.test.ts` matches `MAX_ERROR_CHARS` in this file textually, because the
two packages share no build and that is the only place the client's cap and the server's budget
meet. So renaming that constant, or moving it out of this file, reddens a check in a package this
one has no cue to look in — and nothing on this side says so.
