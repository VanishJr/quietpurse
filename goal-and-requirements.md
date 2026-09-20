---
id: goal-and-requirements
type: goal-and-requirements
status: draft
title: Finto — product goal and scope
---

## Goal

A personal finance tracker that turns the person's own transaction history and account balances
into goals they can act on. Financial independence remains the central question — how much this
person needs to earn to support themselves, with income split into their own and external — and it
sits beside reserve, savings, debt, income, savings-rate and category-spending goals.

It runs on one person's own machine. They upload bank statements in whatever format they happen
to have and get their financial data organised and readable. No account, no server: the database
and the statements are files in one folder on their disk, and nothing to install but Node.

**The import promise: one upload button.** CSV, XLSX, PDF — the user never has to know or care
which parser runs.

## Scope

The web client is the product being built now; native clients come later. That is why the REST
API, not the React app, is the contract: no logic a mobile client cannot reach, and no state that
lives only in the browser.

One person, one folder, one process. The database is PGlite, Postgres compiled to run inside the
Node process, and it lives beside the uploaded statements, which are kept plain in a folder the
person can open. A PostgreSQL server is used only when a connection string names one. There is no
sign-in and no tenant: whoever can reach the port owns the data behind it, so the process binds
the loopback interface unless told otherwise.

A goal is persisted configuration plus a server-computed answer. The API owns every target,
current value, remainder, status and percentage; the web client only formats those answers. A new
installation has no goals until the person creates one. An upgraded installation receives a
Financial independence goal for the former singleton configuration and a category-spending goal
for each former budget.

Out of scope, stated as the products it is not: no hosted copy, no account, no tenant and no
server to rent.

Where the rest lives: `ARCHITECTURE.md` is the module map and the path one statement takes
through it; `AGENTS.md` carries the commands, the invariants and what a green run cannot see;
`SECURITY.md` is the threat model.
