---
name: A statement would not import
about: A file from your bank that Quietpurse refused or imported wrongly
title: ''
labels: bug
---

**Do not attach the statement.** It is your financial data, and an issue is public. You can answer
everything below without it.

## What the app said

<!-- The refusal text, copied exactly. If it imported but the numbers are wrong, say what you
     expected and what you got. -->

## The file

- Format, as the bank calls it (CSV / XLSX / PDF):
- Bank and country:
- Roughly how many rows, and the file size:
- Did the bank offer other formats, and did any of them import?

## The first bytes, for a PDF or a file you are not sure about

A statement can be a signed container that only looks like something else. Any of these will do:

```
# Linux / macOS
head -c 16 statement.pdf | xxd

# PowerShell 7
Format-Hex -Path statement.pdf -Count 16

# Windows PowerShell 5.1
Format-Hex -Path statement.pdf | Select-Object -First 1
```

## A redacted sample, if you can make one

Two or three rows with the amounts, dates and descriptions replaced by made-up values of the same
shape: the same number of columns, the same delimiter, the same date format. That is usually enough
to reproduce a parser problem, and it holds none of your data.

## Version

Commit or branch you are running:
