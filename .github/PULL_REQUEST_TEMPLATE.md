## What this changes

<!-- The user-visible difference first: what was wrong or missing, and what happens now instead.
     Quote the actual before/after text if a message changed. Not a list of edited files. -->

## Why this shape

<!-- The decision someone could reasonably have made differently, and the reason it went this way.
     Skip if there wasn't one. -->

## What holds it

<!-- Which constraint, type, throw or test keeps this true after the next change touches it.
     "A test exists" is weaker than "this test was reverted against the unfixed code and observed
     red" — say which one you have. -->

## Verification

- [ ] `cd backend && npm run typecheck`
- [ ] `cd backend && npm test`
- [ ] `cd web && npm test`

<!-- typecheck covers src and scripts only; a change confined to test files is verified by the
     suite alone. -->

**Manual checks.** Anything jsdom cannot see — layout, downloads, chart rendering — is not covered
by a green run. If this change touches one of those, say which screens were opened, how, and what
was observed. An unrecorded click reads downstream exactly like one that never happened.

## What this does not claim

<!-- The honest edge: what is still unhandled, what was left for a later change, which case you
     could not reproduce. A PR that claims less than it does is cheap; one that claims more costs
     the next reader a round. -->
