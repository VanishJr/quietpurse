<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/logo-dark.svg">
    <img src="media/logo.svg" alt="Quietpurse" width="340">
  </picture>
</p>

<p align="center">
  A personal finance tracker that runs on your own machine.<br>
  Upload statements from any bank and see where your money goes, in one currency.
</p>

<p align="center">
  <a href="https://github.com/VanishJr/quietpurse/actions/workflows/ci.yml"><img src="https://github.com/VanishJr/quietpurse/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <img src="https://img.shields.io/badge/Node.js-22.13%2B-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 22.13 or newer">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/overview-dark.png">
    <img src="media/overview.png" alt="The Overview screen: the account balance, income against expenses, and this month's spending by category" width="900">
  </picture>
</p>

---

## Why

Banking apps show one account in one currency. Once your accounts are spread across banks and
countries, none of them answers the plain questions: what do I actually spend, and how much do I
need to earn to support myself?

Quietpurse keeps that answer current. Importing is one button, categories come from rules rather
than memory, and every figure is recomputed when you open the app. Two things set it apart:

- **Each amount is converted at the rate on its own date**, so one month can be compared with
  another.
- **Income is split into your own and external.** Family support or a stipend is not earnings and
  does not count toward self-sufficiency.

## Installation

Needs Node.js 22.13 or newer, and nothing else.

```bash
git clone https://github.com/VanishJr/quietpurse.git && cd quietpurse
npm run setup
npm start
```

Then open http://localhost:4000. Everything is kept in `~/Quietpurse`: the database and the
statements you uploaded, as plain files you can copy, back up or delete. The only thing the app
fetches from the internet is exchange rates.

## Features

- **One upload button.** CSV, XLSX or PDF, and the right parser is picked for you. Most banks'
  CSV and XLSX exports are read by their column names. PDF statements are read so far from Revolut
  (in Russian), N26 and C24 (in German) and monobank; more banks are on the way.

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/import-dark.gif">
    <img src="media/import.gif" alt="Uploading a statement and checking it before the rows are saved" width="800">
  </picture>

- **Transactions** are categorised by merchant code and description, and a rule moves every
  transaction like this one at once. Transfers between your own accounts, refunds and recurring
  payments are found for you.

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/transactions-dark.png">
    <img src="media/transactions.png" alt="The Transactions screen with categories and filters" width="800">
  </picture>

- **Analytics:** spending and income by category, for a month or a year.

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/analytics-dark.png">
    <img src="media/analytics.png" alt="The Analytics screen: spending by category" width="800">
  </picture>

- **Goals:** financial independence, an emergency fund, savings, paying off a debt, monthly
  income, savings rate and category limits, each computed from your own data.

  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/goals-dark.png">
    <img src="media/goals.png" alt="The Goals screen with progress towards each goal" width="800">
  </picture>

- **Backup** of everything to one JSON file and back, and a dark mode.

## Configuration

Nothing is required. The settings worth knowing; the rest are in `backend/.env.example`:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | the port the app is served on |
| `QUIETPURSE_HOME` | `~/Quietpurse` | the folder everything is kept in |
| `QUIETPURSE_HOST` | `127.0.0.1` | `0.0.0.0` opens the app to a phone on the same Wi-Fi. There is no sign-in, so anyone who can reach the port can read and change your data |

## Development

The backend is Express 5 and TypeScript over Postgres running inside the process (PGlite); the
client is React 19, Vite and Recharts.

```bash
cd backend && npm run dev     # the API on http://localhost:4000
cd web && npm run dev         # the client on http://localhost:5173, proxying /api
npm test                      # both packages
npm run typecheck             # both packages
```

[ARCHITECTURE.md](ARCHITECTURE.md) is the module map, [SECURITY.md](SECURITY.md) the threat model
and [CONTRIBUTING.md](CONTRIBUTING.md) how to propose a change. [AGENTS.md](AGENTS.md) holds the
rules for changing the code, for people and AI agents alike.

## License

[MIT](LICENSE)
