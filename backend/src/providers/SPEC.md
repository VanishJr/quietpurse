# backend/src/providers

Status: draft

What this module is for, where it stops, and the rules about it that no type and no test holds.
Everything already enforced beside the code it governs stays there: `AGENTS.md`'s *Invariants* carry
the diagnostic budget and *Silent success is the failure mode that matters*, and the headers of
`statement.ts`, `pdf.ts`, `sheet.ts`, `csv.ts`, `xlsx.ts`, `issuer.ts` and `pdfjsloader.ts` carry the
reasoning behind the seam, the sniffer, the templates, the decoder and the loader ordering. Nothing
below repeats them.

## What this module owns

- **The one ingestion surface.** Raw bytes in, a staged import out. Nothing reaches `transactions`
  from here: confirming a staged import is one database transaction and lives in
  `backend/src/db/index.ts`, whose own side is stated in `backend/src/db/SPEC.md`.
- **What the bytes are**, decided by their content alone — never by the filename the bank chose and
  never by the browser's declared type.
- **The typed cell seam.** Every front-end hands its rows to the `Sheet` in `sheet.ts`, and from
  there the mapping and the row loop are one path, which is what makes the same statement produce
  the same transactions whichever format it arrives in. The text primitives every path reaches
  through that seam live in `csv.ts`.
- **The sentences a refused import is explained by**, composed here and cut to the budget the data
  layer keeps.
- **The per-format ceiling on what may be held in memory at once**, `SIZE_CAP` in `statement.ts`.

It does not own the transport cap on an upload, the multipart handling or the route that receives
them — those are `backend/src/app.ts`'s — and it does not own the commit.

## Where the boundary runs

**The only file in `backend/src` outside this directory that imports it is `backend/src/app.ts`.**
It takes the ingestion entry point from `statement.ts`, and it also reaches **past** that surface
into `csv.ts` for the preset list the import screen renders. The crossing is deliberate — the
presets are a thing the user picks before an upload, not a thing a parser is handed — and **nothing
enforces it**: no check refuses the next file that imports a parser directly. In `backend/src` the
only other mention of the directory outside it is a comment in `backend/src/db/schema.ts`, not an
import.

**The scope of that rule is product code, and the checks are where it is already crossed.** Files
under `backend/test` reach past `statement.ts` into the parsers themselves —
`backend/test/csv.test.ts` takes `NOTE_MAX` from `pdf.ts` and `MAX_SHEET_ROWS` from `xlsx.ts`,
`backend/test/pdf.test.ts` takes `MAX_DATA_ROWS` from `sheet.ts` — which is single-sourcing a bound
rather than a boundary being broken, and it is why a scan for importers that does not state its
scope answers about the checks while reading as an answer about the product.

**The traffic outward is a fact about where things live rather than an accident.** `statement.ts`
imports the data layer, the categoriser, the document store, the logger and the money helpers;
`xlsx.ts` imports the diagnostic budget from the data layer rather than copying its value, which is
what keeps the derivation single-sourced; `pdf.ts` imports the money helpers. Nothing holds that
list either.

## The invariants no type and no test holds

**A parser version is not its own file's alone, and only one direction of that is written down.**
Each of the constants keyed by import source type in `statement.ts` has its current value pinned by
a literal in a check in `backend/test`, so a bump that *happens* is loud. **Nothing holds that a
bump has to happen.** The row loop runs every format through the cell readers in `sheet.ts`, which
reach the text primitives in `csv.ts` for a cell that arrives as text, and a workbook's columns
through the preset list there together with `resolveColumns` in `statement.ts` — so an edit inside
one of those files parses an existing file of another format differently and must move that
format's number too. Only `xlsx.ts`'s comment admits it; the direction from `pdf.ts` into `csv.ts`
is written in no comment at all, and failing to move a number is the only direction the coupling can
break in.

**The check that requires a refusal to be composed where it can be measured reads one file.**
`backend/test/refusal-set.test.ts` reads `pdf.ts` as source and requires every sentence that
importer can throw to be composed in one place, because a refusal that grows past what the data
layer keeps is invisible otherwise. `statement.ts` and `xlsx.ts` also throw refusals that reach the
same field, composed inline, and no check requires them to be composed anywhere a budget case can
find them.
