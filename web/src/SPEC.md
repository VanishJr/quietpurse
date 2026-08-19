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
  the months an account has rows in; anchoring, filling and comparing are `accounts.ts`'s, and its
  own header states the whole rule.
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

**State that lives only in the browser, named crossing by crossing.** The chart list is written to
`localStorage` by `analytics.ts`, and nothing in `api.ts` calls the server's charts routes, so the
list does not follow a person to a second device — the server side is there, `backend/src/app.ts`
answering `GET` and `PUT /api/analytics/charts` over a table declared in `backend/src/db/schema.ts`,
so this is a client that does not call an endpoint rather than an endpoint that does not exist. The
theme choice is written to `localStorage` by `theme.tsx`; the screen, the account, the open panel
and the selected chart live in the query string and are read back through `url.ts`. `AGENTS.md`'s
*Platforms* states that no state lives only in the browser, because the REST API and not this app is
the contract a mobile client has to reach. **Nothing enforces that, and each of those is a crossing
of it as the code stands today.** Which of them a product wants to keep — a theme is per-device by
design where a chart list is a person's content — is an open question this document does not answer.

**`copy.test.ts` is this package's own check that reads source as text**, and it resolves its root
differently from the checks in the other package on purpose. `backend/test/SPEC.md` states that rule
and the reason for the divergence; it is not restated here.

## The invariants no type and no test holds

**A check in the other package reads `api.ts` as source and finds its error-budget cap by name.**
`backend/test/error-budget.test.ts` matches `MAX_ERROR_CHARS` in this file textually, because the
two packages share no build and that is the only place the client's cap and the server's budget
meet. So renaming that constant, or moving it out of this file, reddens a check in a package this
one has no cue to look in — and nothing on this side says so.
