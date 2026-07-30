# Finto

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-5FA04E?logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
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
  XLSX — and the right parser is picked for you.
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
backend/   Node.js + TypeScript + Express + PostgreSQL 16 + Drizzle + better-auth + vitest
web/       Vite + React + TypeScript + Recharts
```

Data lives in your own PostgreSQL and is never sent anywhere. Access is an email+password
session; each account gets an isolated workspace, so several people can share one server
without sharing data.

## Getting started

Requires Node.js 20+ and a PostgreSQL 16 the backend can reach. The quickest one is the
`postgres` service from `docker-compose.yml`; `DATABASE_URL` in `backend/.env` points at it
by default.

### 1. Backend

```bash
docker compose up -d postgres   # or bring your own Postgres and set DATABASE_URL
cd backend
cp .env.example .env            # an empty file works too — see below
npm install
npm run dev                     # http://localhost:4000, migrations run at startup
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

### Backend in Docker

An alternative to step 1 — requires Docker with the Compose plugin:

```bash
cp backend/.env.example backend/.env
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> backend/.env
docker compose up -d --build           # backend on http://localhost:4000
```

Unlike `npm run dev`, the image runs with `NODE_ENV=production`, and in production the
backend refuses to start on development defaults — an unset `BETTER_AUTH_SECRET` above
all, since sessions would be signed with a key that is published in this repository.
Hence the second line; an empty `.env` is enough only for `npm run dev`.

This starts Postgres alongside the backend; the data stays in the `pgdata` volume, and
port 5432 is published on localhost so a non-Docker `npm run dev` reaches the same
database. The web client still runs separately (step 2).

### 3. First run

The app opens on a register/login screen — the first account you create becomes the
server's first workspace. After that, with an empty database it opens a short wizard:
base currency, the name your bank writes in statements, and the statement itself.
Nothing here asks for API access to a bank — a file you exported is all it takes.

The Goal screen starts empty too: add the line items of your own bare minimum (rent,
food, transport…) right on the screen — nobody else's guesses would fit anyway.

## Configuration

Secrets and process settings live in `backend/.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `BETTER_AUTH_SECRET` | key session cookies are signed with. **Set this on any real deployment** (`openssl rand -base64 32`); the dev fallback is public and the backend warns about it at startup |
| `BETTER_AUTH_URL` | the backend's address as browsers see it, defaults to `http://localhost:PORT` |
| `CORS_ORIGINS` | origins allowed to call the API with session cookies, comma-separated. Only needed when the web client is served from a different origin than the backend |
| `SIGNUP_INVITE_CODE` | when set, registration requires this code. Empty (the default) means anyone who can reach the server can sign up |
| `DATABASE_URL` | PostgreSQL connection string, defaults to the `postgres` service in `docker-compose.yml` |
| `DOCUMENT_ENCRYPTION_KEY` | key the uploaded statements are sealed with on disk. **Set this on any real deployment** (`openssl rand -base64 32`); the backend refuses to start under `NODE_ENV=production` on the public dev fallback. Changing or losing it makes every document already stored unreadable |
| `DOCUMENT_STORE_PATH` | where those documents are kept, defaults to `./data/documents` (relative to `backend/`), which is where `docker-compose.yml` mounts the `documents` volume |

There is no client-side secret: `web/` ships no credentials at all. Access is a cookie
session obtained from the login screen.

Everything else — base currency, account owner names — is edited in the app itself and
stored in the database, per workspace. `OWNER_NAMES` and `FAMILY_NAMES` in `.env` seed
the server's first workspace only; every later workspace starts empty and fills those
in on the settings screen.

### Accounts and workspaces

Each account gets its own **workspace** with its own accounts, transactions, settings, rules
and budgets; users on the same server never see each other's data. Registration is open by
default — set `SIGNUP_INVITE_CODE` to close it before exposing the server beyond your own
machine.

## Development

```bash
cd backend && npm test        # vitest
cd backend && npm run typecheck
cd web && npm run build       # tsc --noEmit + build
```

The database schema lives in `backend/src/db/schema.ts`. SQL migrations are generated from
it (`npm run db:generate`) into `backend/drizzle/` and applied at startup.

> Until the prototype is deployed anywhere real, a schema change may be folded into the
> existing migration by regenerating it — the migration history has no databases to
> upgrade yet. **From the first deployment on, migrations are append-only** and an applied
> one is never edited.

Every data table is scoped by `workspace_id`, and the data layer takes that scope from
AsyncLocalStorage rather than from a parameter (see `backend/src/db/workspace.ts`): the
session middleware sets it per request, background jobs set it per workspace. A db call
with no scope throws rather than running unscoped — `backend/test/workspace-scope.test.ts`
(the mechanism) and `backend/test/tenant-isolation.test.ts` (two workspaces' data) are what
keep that honest.

An existing SQLite database from the pre-Postgres era is imported with
`npm run migrate:sqlite` — it loads into one workspace (the oldest by default,
`--workspace <id>` to pick another).

An update that adds a migration applies it on the next start. Dump the database first if
the data matters to you (`docker compose exec postgres pg_dump -U finto finto > dump.sql`)
— the app also has a one-click JSON backup on the Overview screen.

## License

MIT — see [LICENSE](LICENSE).
