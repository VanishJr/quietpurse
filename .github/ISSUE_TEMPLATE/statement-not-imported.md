---
name: A statement would not import
about: A file your bank gave you that Quietpurse refused, or imported wrongly
title: ''
labels: import
---

**Do not attach the statement.** It is your financial data, and an issue is public. Everything
below can be answered without it.

## What the app said

<!-- The refusal text, copied exactly. If it imported but the numbers are wrong, say what you
     expected and what appeared instead. -->

## The file

- Format the bank calls it (CSV / XLSX / PDF):
- Bank and country:
- Roughly how many rows, and the file size:
- Did the bank offer other formats? Did any of them import?

## The first bytes, if it is a PDF or you are not sure what it is

A statement can be a signed container that only looks like something else. Either is fine:

```
# Linux / macOS
head -c 16 statement.pdf | xxd

# Windows PowerShell
Format-Hex -Path statement.pdf -Count 16
```

## A redacted sample, if you can make one

Two or three rows with the amounts, dates and descriptions replaced by made-up values of the same
shape — same column count, same delimiter, same date format. That is usually enough to reproduce a
parser problem and it carries none of your data.

## Version

Commit or branch you are running:
