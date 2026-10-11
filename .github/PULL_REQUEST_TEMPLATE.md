## What this changes

<!-- What the user sees differently: what was wrong or missing, and what happens now. Quote the
     before and after text if a message changed. Not a list of edited files. -->

## Why this shape

<!-- A decision someone could reasonably have made differently, and why it went this way. Skip if
     there was none. -->

## What holds it

<!-- Which constraint, type, throw or test keeps this true after the next change. "A test exists" is
     weaker than "this test was run against the unfixed code and failed"; say which you have. -->

## Verification

- [ ] `npm run typecheck` (both packages, test files included)
- [ ] `npm test` (both packages)

**Manual checks.** A green run does not cover what jsdom cannot see: layout, downloads, chart
rendering. If this change touches one of those, say which screens you opened, how, and what you saw.
A click nobody recorded counts as one that never happened.

## What this does not claim

<!-- The honest edge: what is still unhandled, what was left for later, which case you could not
     reproduce. Claiming less than you did is cheap; claiming more costs the next reader a round. -->
