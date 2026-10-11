---
name: Bug report
about: Report something that isn't working as expected
title: ''
labels: bug
assignees: ''
---

<!-- A bank statement would not import? Use the other template: it asks what parser problems need.
     A security issue? Do not open an issue. Use GitHub's private vulnerability reporting (see SECURITY.md). -->

## Description

A clear and concise description of what the bug is.

## Steps to reproduce

1. ...
2. ...
3. ...

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include logs, stack traces, or screenshots if relevant.

<!-- With LOG_LEVEL=debug every request is logged with its full URL, query included: account ids,
     categories, dates. A refused request is logged that way even without it. A screenshot of the
     app shows your accounts and amounts. Check logs and screenshots for account names, amounts and
     statement filenames before pasting. -->

## Environment

- OS:
- Node version (`node --version`):
- Quietpurse commit (`git rev-parse --short HEAD`):
- Database: the built-in one in `~/Quietpurse/db`, or your own PostgreSQL (version):
- Browser, for a problem in the web client:
