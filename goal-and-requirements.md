---
id: goal-and-requirements
type: goal-and-requirements
status: draft
title: Finto — product goal and scope
---

## Goal

A personal finance tracker built around one question: how much does this person need to earn to
support themselves. It pulls transactions from several banks, converts every amount to one
currency at the rate on the transaction's date, and works out the self-sufficiency threshold —
with income split into the person's own and external.

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

Out of scope, stated as the products it is not: no hosted copy, no account, no tenant, no server
to rent, no upgrade path from anything earlier than the first release.

Where the rest lives: `ARCHITECTURE.md` is the module map and the path one statement takes
through it; `AGENTS.md` carries the commands, the invariants and what a green run cannot see;
`SECURITY.md` is the threat model.
