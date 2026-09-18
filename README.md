# Finto

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-5FA04E?logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![PGlite](https://img.shields.io/badge/PGlite-embedded_Postgres-4169E1?logo=postgresql&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

[![CI](https://github.com/VanishJr/finto/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/VanishJr/finto/actions/workflows/ci.yml)

A personal finance tracker built around one question: **how much do I need to earn to
support myself?** It pulls transactions from several banks, converts everything to a single
currency, and works out the self-sufficiency threshold.

It runs on your own machine. There is no account to create, no server to rent and nothing to
install but Node.js: two commands, and your statements sit in a folder you can open.

---

## Why

Banking apps are good at showing one account in one currency. Once the accounts live in
different banks and different countries, none of them answers the plain questions: what do
I actually spend, which part of that is unavoidable, which part is one-off purchases, and
how much income am I short of living on my own.

Exporting to a spreadsheet answers that exactly once — a month later the data is stale, and
the category work and exchange rates are back to being done by hand. Finto is an attempt
to make that calculation permanent: the import is one button, the categorization lives in
rules rather than in your head, and the headline number is recomputed every time you open
the app.

Hence two things most trackers don't do:

- **Everything is converted at the rate on the transaction date**, not today's rate.
  Otherwise comparing one month to another is meaningless.
- **Income is split into your own and external.** Family support, a stipend and the like
  aren't earnings, and they don't count toward self-sufficiency.

## Features

- **Accounts.** One upload button: a statement in whatever format the bank gives you — CSV,
  XLSX, PDF — and the right parser is picked for you.
- **Transactions.** Auto-categorization by MCC and description; "all transactions like this
  one go to this category" rules; detection of transfers between your own accounts, refunds
  and one-off purchases.
- **Analytics.** Spending and income by category for a month or a year, recurring payments,
  per-category budgets with a "will you stay under it" forecast.
- **Goal.** The self-sufficiency threshold in two modes: from a bare minimum (housing, food,
  transport…) and from your current lifestyle. Shortfall, self-sufficiency by month, the
  same number expressed in working hours, and "what if I cut spending" scenarios.

## Stack

```
backend/   Node.js + TypeScript + Express + Postgres embedded in the process (PGlite) + Drizzle + vitest
web/       Vite + React + TypeScript + Recharts
```

The data never leaves your machine: the database and the statements you upload are files
in one folder, and the only thing the app ever fetches from the internet is exchange rates.

## Getting started

Requires Node.js 22 or newer. Nothing else.

```bash
git clone https://github.com/VanishJr/finto.git && cd finto
npm run setup     # installs both packages and builds the web client
npm start         # http://localhost:4000
```

Open the address it prints. The app opens on Overview, empty, with a button that takes you
straight to the import; the base currency and the name your bank writes in statements are on
the Settings screen. Nothing here asks for API access to a bank — a file you exported is all
it takes.

The Goal screen starts empty too: add the line items of your own bare minimum (rent, food,
transport…) right on the screen — nobody else's guesses would fit anyway.

Stop it with Ctrl+C. Start it again the same way; your data is where you left it.

### Coming from an earlier checkout

Migrations are append-only: a schema change is a new migration file after the last one, and
a database this build's initial migration created is upgraded in place on the next start,
with your transactions where they were.

**A database whose initial migration is not the one this build ships is the exception.** Before
the forward migrations existed, every schema change was folded into the one initial migration by
regenerating it, so a database migrated by an older regeneration carries a file this build does
not have, and there is no repair and no conversion. The start says so rather than guessing: it
either dies with `relation "accounts" already exists` or refuses, naming the migration it does not
know. When it does, delete the database and start again:

```bash
rm -rf ~/Finto/db
```

Your uploaded statements in `~/Finto/statements/` are untouched by any of this. Import them
again once the app starts. If you point `DATABASE_URL` at a PostgreSQL server, drop that
database instead and let the app create it again; if you have run the test suite against a
`*_test` database of your own, drop that too.

## Where your data is

```
~/Finto/
  db/            the database
  statements/    every statement you uploaded, under a name you can recognise
  finto.lock     the running app's process id, so a second copy refuses to open the same folder
  finto.lock.takeover/  left only by a start that died mid-takeover; safe to delete when no Finto is starting
```

Set `FINTO_HOME` to keep it somewhere else. The whole folder is yours to copy, back up or
delete; the app also has a one-click JSON export of every transaction on the Settings
screen, and Import history offers each uploaded file back.

The files in `statements/` are exactly the files you uploaded, unencrypted. What protects
them is whatever protects the rest of your disk — see `SECURITY.md` for the trade-off that
is.

## Configuration

Nothing is required. `backend/.env.example` lists what can be set; the ones worth knowing:

| Variable | Purpose |
|---|---|
| `PORT` | the port the app is served on, defaults to `4000` |
| `FINTO_HOME` | the folder everything lives in, defaults to `~/Finto` |
| `FINTO_HOST` | listen on every network interface (`0.0.0.0`) instead of this machine only — for a phone on the same Wi-Fi. There is no sign-in, so everyone who can reach the port can read and change your data |
| `OWNER_NAMES`, `FAMILY_NAMES`, `BASE_CURRENCY` | seed the settings on the first start; after that they are edited in the app |
| `DATABASE_URL` | use a PostgreSQL server instead of the embedded database |
| `DOCUMENT_STORE_PATH` | keep the uploaded statements somewhere other than `FINTO_HOME/statements` |

## Development

```bash
cd backend && npm run dev     # tsx watch, on http://localhost:4000
cd web && npm run dev         # Vite on http://localhost:5173, proxying /api to the backend

cd backend && npm test        # vitest, on an embedded database of its own
cd backend && npm run typecheck
cd web && npm test
cd web && npm run build       # tsc --noEmit + build, into web/dist
```

The dev server proxies `/api` to `http://localhost:4000`, so there is no address to
configure; set `BACKEND_URL` if the backend runs elsewhere.

`cd web && npm run build` (and `npm run typecheck`) needs `backend/` installed: the client's
types are the server's own declaration in `backend/src/wire`, and compiling it resolves `zod`
from `backend/node_modules`. `npm run setup` installs `backend/` before it builds `web/`, and the
order is load-bearing: reversed, the client's typecheck fails on `zod`.

The database schema lives in `backend/src/db/schema.ts`. SQL migrations are generated from
it (`npm run db:generate`) into `backend/drizzle/` and applied when the app starts.

> **Migrations are append-only, and `0000_initial.sql` is never regenerated.** A schema change
> is a new file after the last one, and an applied migration is never edited. A database whose
> initial migration is an older regeneration this tree does not ship cannot be upgraded — the
> start refuses it or dies with `relation "accounts" already exists` — and the step under
> *Coming from an earlier checkout* is for that database and no other.

## Documentation

| File | What it answers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The module map, the path one statement takes from upload to committed rows, and how to add a format |
| [`SECURITY.md`](SECURITY.md) | What protects your data on your own machine, and the one trade-off taken on purpose |
| [`AGENTS.md`](AGENTS.md) | What to read before changing anything: the invariants, and what the test suite structurally cannot see |
| [`.agents/README.md`](.agents/README.md) | How a task is run here, and which checks are worth trusting — ranked by whether a check can be wrong about itself |

## License

MIT — see [LICENSE](LICENSE).
