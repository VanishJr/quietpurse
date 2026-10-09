# Contributing to Finto

Thanks for looking. Finto is a personal finance tracker that runs on one person's own machine, so
the bar for a change is that it keeps that person's data correct and on their disk.

## Before you change anything

Read [`AGENTS.md`](AGENTS.md). Despite the name it is written for people as much as for coding
agents: the layout, the commands, the invariants a change must keep, and what the test suite
structurally cannot see. [`ARCHITECTURE.md`](ARCHITECTURE.md) is the module map and
[`SECURITY.md`](SECURITY.md) the threat model.

## Setting up

Node.js 22.13 or newer.

```bash
npm run setup                     # installs backend/ and web/, builds the client
npm start                         # http://localhost:4000, data under ~/Finto
```

While working, run the two halves separately:

```bash
cd backend && npm run dev         # the API, restarted on change
cd web && npm run dev             # the client, with hot reload
```

## The checks a change has to pass

```bash
cd backend && npm run typecheck && npm test
cd web && npm run typecheck && npm test
```

Run them; a change is not finished on a claim that they pass. CI runs the same checks, and runs the
backend suite a second time against a real Postgres.

A green run does not cover layout, downloads or chart rendering — jsdom cannot see them. If your
change touches one of those, open the affected screens in a browser and say in the pull request
which ones, how, and what you saw. "Verification has a hole" in `AGENTS.md` lists what that means
screen by screen.

## Pull requests

- One change per pull request. The template asks what changes, why it has this shape, what keeps it
  true, and how it was verified — fill in the parts that apply.
- Comments follow the rules under *Conventions* in `AGENTS.md`: the reasoning goes to the module's
  `SPEC.md`, and a comment never states a fact a test could check.
- Contributions are accepted under the [MIT license](LICENSE).

## Bank statements

**Never attach a real statement or paste real rows** — not in an issue, a pull request or a
fixture. Fixtures are built in code with invented values (`backend/test/pdffixture.ts` for PDFs).

If a statement will not import, open an issue with the *A statement would not import* template. It
asks for the refusal text and the shape of the file, and shows how to make a redacted sample.
