# Finto

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-5FA04E?logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

A personal finance tracker built around one question: **how much do I need to earn to
support myself?** It pulls transactions from several banks, converts everything to a single
currency, and works out the self-sufficiency threshold.

---

## Why

Banking apps are good at showing one account in one currency. Once the accounts live in
different banks and different countries, none of them answers the plain questions: what do
I actually spend, which part of that is unavoidable, which part is one-off purchases, and
how much income am I short of living on my own.

Exporting to a spreadsheet answers that exactly once — a month later the data is stale, and
the category work and exchange rates are back to being done by hand. Finto is an attempt
to make that calculation permanent: banks sync themselves, the categorization lives in
rules rather than in your head, and the headline number is recomputed every time you open
the app.

Hence two things most trackers don't do:

- **Everything is converted at the rate on the transaction date**, not today's rate.
  Otherwise comparing one month to another is meaningless.
- **Income is split into your own and external.** Family support, a stipend and the like
  aren't earnings, and they don't count toward self-sufficiency.

## Features

- **Accounts.** Monobank directly, Revolut / N26 / any EU bank via
  [Enable Banking](https://enablebanking.com), plus CSV statement import for banks with no API.
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
backend/   Node.js + TypeScript + Express + better-sqlite3 + vitest
web/       Vite + React + TypeScript + Recharts
```

Data lives in a local SQLite file and is never sent anywhere. There is no login: the app is
meant for a single user on their own network.

## Getting started

Requires Node.js 20+.

### 1. Backend

```bash
cd backend
cp .env.example .env      # an empty file works too — see below
npm install
npm run dev               # http://localhost:4000
```

### 2. Web client

```bash
cd web
npm install
npm run dev               # http://localhost:5173
```

The dev server proxies `/api` to `http://localhost:4000`, so there is no address to
configure. If the backend runs on another port or host, set `BACKEND_URL` (the proxy
target) or `VITE_API_URL` (the address the browser uses) — see `web/.env.example`.

### 3. First run

With an empty database the app opens a short wizard: base currency, the name your bank
writes in statements, and a way to get data in — a Monobank token, a bank through Enable
Banking, or a CSV statement you already have. A statement is the fastest way to see
something real without handing out any API access.

The Goal screen starts empty too: add the line items of your own bare minimum (rent,
food, transport…) right on the screen — nobody else's guesses would fit anyway.

## Configuration

Secrets and process settings live in `backend/.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `API_KEY` | shared secret; the client sends it in the `x-api-key` header. Without it the API is open to everyone on the local network |
| `MONOBANK_TOKEN` | token from [api.monobank.ua](https://api.monobank.ua) |
| `EB_APP_ID`, `EB_PRIVATE_KEY_PATH` | Enable Banking credentials |
| `DB_PATH` | database file path, defaults to `backend/data/finto.db` |

The same `API_KEY` goes into `web/.env` as `VITE_API_KEY`.

> The key is baked into the client bundle in plain text — unavoidable for a browser app.
> That's fine on a local network, but a public deployment should run on demo data with a
> separate key, never on your real database.

Everything else — base currency, account owner names, sync interval — is edited in the app
itself and stored in the database.

## Development

```bash
cd backend && npm test        # vitest
cd backend && npm run typecheck
cd web && npm run build       # tsc --noEmit + build
```

The database schema is versioned by migrations in `backend/src/migrations/`: the applied
version is kept in `meta.schema_version`, and every migration with a higher number runs at
startup. A new migration is a new `NNN-name.ts` file; applied ones are never edited.

An update that adds a migration applies it on the next start. Copy `backend/data/` first
if the data matters to you — the app also has a one-click backup on the Overview screen.

## License

MIT — see [LICENSE](LICENSE).
