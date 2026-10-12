---
id: submodule-backend-providers
type: submodule-design
status: draft
title: The one ingestion surface and the per-format parsers behind it
parent: module-backend
---

## Responsibility

This module turns uploaded bytes into a staged import, under the rules below that no type and no
test holds; the diagnostic budget and *Silent success is the failure mode that matters* are in
`AGENTS.md`.

- **One ingestion surface.** `POST /api/imports` hands the bytes to `statement.ts`, which decides
  what they are, picks a parser and stages the rows behind a summary the person must accept. Nothing
  reaches `transactions` from here. Confirm inserts the rows and recomputes the balance in one
  database transaction in `backend/src/db/index.ts` (see `backend/src/db/SPEC.md`); the route in
  `backend/src/app.ts` then calls `reclassifyAll`, which reclassifies and backfills the base amounts
  on its own queue in `backend/src/classify.ts`.
- **The bytes decide the format**, never the filename the bank chose or the browser's declared type;
  neither is checked anywhere. The sniffer answers a type and nothing else. Handing no bytes back,
  it cannot give its caller a different buffer, so the bytes hashed, stored and parsed stay one
  buffer even when the document starts at an offset. **Every refusal the sniffer composes says what
  to do instead.** The person chose the file in their bank's export screen, and a bare "unsupported"
  leaves them stuck. A refusal site added later owes the same, and nothing checks it.
- **The typed cell seam.** Every frontend hands its rows to the `Sheet` in `sheet.ts`. From there
  the mapping and the row loop are one path, so a statement gives the same transactions in any
  format. The text primitives behind the seam live in `csv.ts`.
- **The sentences that explain a refused import**, cut to the budget the data layer keeps.
- **The per-format memory ceiling**, `SIZE_CAP` in `statement.ts`.

It does not own the transport cap, the multipart handling or the route, which are
`backend/src/app.ts`'s, and it does not own the commit.

**Deduplication is the caller's.** A statement row carries no bank reference, so the insert computes
the dedup key from the row's stable fields. That needs the whole file in one call: a statement's
rows are held in memory together, and `MAX_DATA_ROWS` in `sheet.ts` aborts an import rather than
truncating it. A statement covers whole days, so every group of identical rows arrives complete, and
a half-imported statement reported as a success is worse than a refusal.

**The write order is load-bearing.** Hash and look up first, so a re-upload costs nothing. Write the
import row before anything else, so a failure leaves a failed import, not nothing. Store the
document next, before the parse and inside the same catch. The row is not in a transaction with the
parse, because a rollback would erase the failure record. The catch covers the staging too: a throw
after staging still ends in a failed import, and `failImport` in `backend/src/db` drops its staged
rows in the same transaction.

**Which refusals leave an `imports` row is a rule every new refusal site owes.** Whatever is decided
without opening the file leaves none: an account that cannot take the upload, a type the sniffer
refuses, a file past the size cap, an unknown preset. `failed` means "an import did not complete",
not "the person picked the wrong file". Whatever needs the file opened leaves a failed row: a zip
that is not a workbook, a sheet with no header, a PDF that is password-protected, past the page cap
or still being read at the deadline. Opening decides the band, not how much was parsed: an encrypted
PDF parses nothing either.

**A parse cannot be interrupted, and that is a rejected design, not an oversight.** The deadline in
`statement.ts` stops accidental pathology, not someone who is trying, and stopping that needs an
execution context that can be terminated, a second thread; this process has one. It is acceptable
because on the default loopback bind the only uploader is the person at the machine. A wider bind
opens the port to the whole network, and `SECURITY.md` says so beside the setting.

## Boundary

**In `backend/src`, only `backend/src/app.ts` imports this directory**: the entry point from
`statement.ts` and, past that surface, the preset list and the `CsvMapping` type from `csv.ts`. The
crossing is deliberate, since the person picks a preset before any parser runs. Nothing enforces it.

**That rule is for product code.** Tests import parsers directly to single-source a bound:
`backend/test/csv.test.ts` takes `NOTE_MAX` from `pdf.ts`. A scan for importers has to state its
scope, or it answers about the tests while seeming to answer about the product.

**`xlsx.ts` imports the diagnostic budget from the data layer rather than copying it**, which keeps
the derivation single-sourced.

**The PDF reader's stubs exist because of a dependency fact, and go in before pdfjs loads.** pdfjs
takes `DOMMatrix` and `Path2D` from an optional canvas package, a renderer far larger than the
text-layer parser, which npm silently skips where no prebuilt binary fits. Without those globals
pdfjs fails to evaluate, so on exactly those machines every PDF import would be refused.
`pdfjsloader.ts` is the mechanism and states the ordering rule, and
`backend/test/canvasabsent.test.ts` holds it in a child process where the package cannot resolve.

## The seam every frontend hands its rows to

`Sheet` in `sheet.ts` is the contract, and each field is an obligation on a new frontend. Its author
reads this, not `sheet.ts`.

- **`rows`**: the header row first, blank rows already dropped, so a row of nothing but formatting
  never reaches the mapper's counts.
- **`rowLabel`**: what a problem message calls a row, the sheet row or the CSV line. Its width feeds
  the diagnostic budget, so labels wider than the measured paths change what every reason may spend.
- **`note`**: why the frontend blanked a cell, such as a formula with no cached result or an error
  value, so the mapper says that instead of "could not parse the amount". No preset fixes amounts
  that were never computed.
- **`notices`**: facts about the file that the mapper cannot see and the person must be told, an
  unread sheet among them. They go into `problems` ahead of the row problems, because they are not
  rejected rows.
- **A cell is not text.** A workbook gives a date as a date and an amount as a float, and running
  either back through the text parsers throws away what the file knew. So the mapper branches on the
  cell type. A string array is assignable to a cell array, so the CSV path reaches the same
  functions with the same arguments.
- **A workbook cell is normalised by its type, never through the renderer exceljs offers**, which
  writes a date the platform's way. A formula's cached result is normalised the same way: computed
  amount columns are common in bank exports and must stay numbers.
- **The header scan's predicate is the mapper's own column resolution, called through one
  function.** A laxer scan settles on a row above the real header, every data row is then read
  against the wrong columns, and a plausible count is reported as a success. One function keeps
  `xlsx.ts` and `statement.ts` from disagreeing.

## What a CSV preset is, and what its author owes

A bank ships one export per language its app offers. So each preset column is a list of accepted
names, its row filter a set of accepted values, and the file's header decides which apply. Candidate
order breaks a tie, so the more specific name goes first.

- **Every accepted name comes from a header somebody has actually seen.** A wrong guess costs
  nothing. A guess that exactly names a *different* column is a silent mis-mapping, and a list that
  looks complete hides the next failure. Coverage grows from real files.
- **`description` is a list of lists on purpose**: the outer list is the join order, the inner one
  the names accepted for that column. Flattened, both would be a list of strings, in a type a Zod
  schema mirrors by hand, and a second accepted name in a two-column description would silently join
  three columns.
- **The delimiter, the date format and the decimal separator stay scalar.** The delimiter is
  resolved before any header exists, so a list would have nothing to resolve against.
- **Only a preset can declare `fee`**: not the generic mapper, not a request. Why is written beside
  `GENERIC_CANDIDATES` in `csv.ts`.
- **Only a preset can declare `balance`, for the opposite reason.** A guessed balance column does
  not corrupt, it *refuses* a file that imports today, on the fallback path every uncovered user is
  sent to. The series column is nested inside it, because a series without a balance has no reader.
- **The hash is over the raw bytes, never the decoded text**, so the encoding the decoder chose
  cannot change whether an upload counts as already imported.

## What a PDF template is, and what its author owes

A PDF's text comes in the order it was drawn, not the order it is read. Two columns interleave, and
a row built by array position gets its neighbour's amount: parsed, accepted, plausible and wrong. So
the reader groups by coordinate.

- **Which coordinate is which column is a template**, per layout rather than per bank, measured off
  a real document; it cannot be derived. The measurements and their reasons sit beside each template
  in `pdf.ts`.
- **A layout no template matches is refused by name**, never read against the nearest fit, and every
  template is tried, never just the first match (`selectTemplate` says why).
- **A field the author could not find is a named "no", never left out.** An optional field spells
  "this layout prints none" and "the author did not look" the same way, and the second ships a
  categorisation silently worse than it could be. **The opening and closing balances have no "no" at
  all.** Otherwise an author unsure of a layout could write away the weakest parser's only check. A
  document without balances is simply not a template. The per-side totals are the exception: without
  them the two balances are still checked, so that "no" switches nothing off.
- **An on-top fee cannot be written in a PDF template**, deliberately. The two conventions corrupt
  money in opposite directions. An author who meets an on-top layout has to add the arm, and `tsc`
  then forces its case at the mapper in the same edit.
- **A continuation template states which labelled lines carry an account or card number.** Both
  continuation kinds of `RowExtent` require `accountNumbers`. `not-printed` means no such line.
  `printed` lists under `kept` the labels of such lines the template appends to the description
  whole, and under `dropped` those it refuses.
  - By default such a line is dropped, and its label declared under `dropped`.
  - `kept` is for a layout where the counterparty's number and name are one text item, so no rule
    keyed on the label or a coordinate can keep the name without the number. A rule on the value's
    characters is refused, for the reason given beside the `n26-de` template.
  - `kept` records the labels under which a number was seen on the source document. A label in
    `keep` but not in `kept` is still appended whole, because `wanted` reads `keep`, not the stance.
  - The stance drives nothing: `wanted` decides off `keep` and `drop` alone, and the docblock on
    `AccountNumbers` says why it must not gain a reader (see also *Invariants*).
  - It exists because the categoriser, the transfer detector, the recurring key, the CSV export and
    the backup all read a stored description whole, so what a template appends is a decision about
    each of them, made per template.
  - It is prospective: nothing re-parses a stored statement or rewrites a stored description, so an
    edited template changes what the next upload stores and nothing already in the database.

## The diagnostic budget, and the one chain written in code

The budget is **one chain** across `statement.ts`, `xlsx.ts`, `pdf.ts` and the data layer.
`ERROR_DETAIL_MAX`, declared in `backend/src/wire/index.ts` and enforced in
`backend/src/db/index.ts`, bounds the composed sentence. What its fixed prose leaves bounds a row's
reason. What a reason's prose and its row label leave bounds a frontend's note.

**The chain is written whole in one place, in code, above `CELL_QUOTE_MAX` in `statement.ts`, and it
stays there**, with why it is not split and why a note producer writes against the widest-label
path's figure rather than its own. What yields when a sentence does not fit is decided where it is
composed (`AGENTS.md`): fixed prose is never shortened, and a refinement yields before a fact with
no other channel.

**An unread sheet is such a fact.** If a workbook's first month is formatted past the early-out, the
second month imports with a success card, and only the notice says a month is missing. A log reaches
support, not the person, and the `imports` row records nothing about a skipped sheet. The selection
loop stops at the first sheet whose header resolves, so the unused list is derived from the whole
workbook, not from the sheets tried. Hidden and empty sheets are never named: the selector skips
hidden ones too, and blank spare sheets are common, so naming either flags an import with nothing
wrong with it. It is **one notice however many sheets went unread, for however many causes**,
because notices share the bounded `problems` array with the row reasons and one entry per sheet
would evict them. Re-uploading is not offered: after confirmation the same bytes answer "already
imported" unparsed, so the exit that works is saving the other sheets as separate files.

## Invariants

**A parser version depends on more than its own file, and only half of that is held.** Each
`PARSER_VERSION` entry in `statement.ts` is pinned by a literal in a test, so a bump is loud.
**Nothing makes a bump happen.** It is due whenever an edit changes how an existing file parses, and
that edit can sit elsewhere: every format runs through the cell readers in `sheet.ts`, which reach
the text primitives in `csv.ts` for a cell that arrives as text, and a workbook's columns through
the presets in `csv.ts` and `resolveColumns` in `statement.ts`. An edit there can change another
format and must move that format's number.

**Only the PDF importer's refusals are checked for length as a set, and that is a gap.**
`backend/test/refusal-set.test.ts` requires every refusal `pdf.ts` throws to be named in
`refusals()`, where its length is checked against what the data layer keeps. `statement.ts` and
`xlsx.ts` compose refusals inline for the same field, and no such set holds them.

**No note producer is held to its budget.** The arithmetic is checked, the next producer is not, and
a note over budget evicts a clause the person needed. The block above `CELL_QUOTE_MAX` says why a
blanket cut cannot help.

**Nothing checks a template against a second document.** Each span is measured off one file, and a
span on a neighbouring column is silent where its value reaches no gate. The guard in
`backend/test/pdf.test.ts` holds the spans that can be checked; a layout whose next document differs
is held by nothing.

**A `not-printed` stance is an unchecked assertion**, like `fee: { kind: 'none' }` and `mcc: { kind:
'none' }`: a named "no" held only by whoever read the document. Unlike the balances, a wrong one
switches nothing off, because nothing reads it. The guard in `backend/test/pdf.test.ts` holds the
stance against the `keep` and `drop` lists, a `printed` stance to name a label, and every identifier
label in a list to be declared, so a cloned template with an identifier in `drop` cannot claim
`not-printed`; its docblock says how each clause matches prefixes. No guard holds the document: a
number under an undeclared label, stamped `not-printed` by an author who did not look, stays green
until the next reader.

**A fee's convention is held by `tsc`'s exhaustive switches and nothing else.** The conventions move
the amount in opposite directions, so a producer that omits the convention, or a consumer that
assumes one, makes money silently wrong instead of failing the import.

**One broken run refuses the whole file.** When a running balance's links do not form one unbroken
run, the reconciliation gate refuses the file, whatever the other runs show. The file's own
arithmetic says money is missing, and a statement short by a row, staged for confirmation, is the
failure `AGENTS.md` ranks above a crash. A blank cell in a pocket the person barely uses may not
disarm the check for the account beside it. A run the parser cannot use is skipped, not examined, so
an imperfect read is not refused for it; why that is safe is written above `checkSheet` in
`statement.ts`.

**A diagnostic never carries an account number.** `issuerName` in `issuer.ts` returns a name or
nothing, never the IBAN, because its answer lands in `imports.error_detail`, which is stored and
shown back. Its table of institutions is written by hand, entry by entry, never bulk-imported: a
stale table names a bank that has merged away, in the one sentence whose value is that the person
holding the file can check it.

**The issuer rule was measured, not reasoned.** A name is asserted only when exactly one IBAN-shaped
token appears on *every* page of a document of more than one page, and that token is in the table.
On the statements it was built against, the most frequent IBAN is a counterparty's, so frequency
would name the wrong bank. The account's own IBAN repeats as page furniture, and one page cannot
show repetition.
