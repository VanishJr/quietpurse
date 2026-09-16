---
id: submodule-backend-providers
type: submodule-design
status: draft
title: providers — the one ingestion surface and the per-format parsers behind it
parent: module-backend
---

What this module is for, where it stops, and the rules about it that no type and no test holds.
Everything already enforced beside the code it governs stays there: `AGENTS.md`'s *Invariants* carry
the diagnostic budget and *Silent success is the failure mode that matters*. What is left in the
source files beside this one is the reasoning an edit to its own line would break — a sentinel's
meaning, a sign or rounding convention, why a clause is absent from one expression, the spans each
PDF template was measured at, and the diagnostic derivation named under *The diagnostic budget*
below together with the bounds derived against it. Anything a reader working in another file needs
belongs here rather than in a comment — **and nothing holds that**: no check can tell a reason that
was moved from one that was dropped, so a block deleted from a source file without arriving here is
green.

## Responsibility

- **The one ingestion surface.** Raw bytes in, a staged import out. `POST /api/imports` hands the
  bytes to `statement.ts`, which decides what they are, picks a parser, and stages the rows behind a
  summary the user has to accept. Nothing reaches `transactions` from here: confirming a staged
  import runs the rest of the pipeline — the insert, the reclassification, the base-amount backfill
  — and it is one database transaction in `backend/src/db/index.ts`, whose own side is stated in
  `backend/src/db/SPEC.md`.
- **What the bytes are**, decided by their content alone — never by the filename the bank chose and
  never by the browser's declared type, neither of which is checked anywhere. The sniffer answers a
  type and nothing else, deliberately: a classifier with no bytes to hand back cannot give a caller
  a buffer different from the one it was passed, so the bytes hashed, the bytes stored and the bytes
  parsed stay one buffer even for a file whose document starts at an offset. **Every refusal the
  sniffer composes owes a sentence saying what to do instead**, because the person holding the file
  chose it in their bank's export screen and a bare "unsupported" leaves them nowhere to go; a
  refusal site added later owes the same and nothing checks that it paid.
- **The typed cell seam.** Every front-end hands its rows to the `Sheet` in `sheet.ts`, and from
  there the mapping and the row loop are one path, which is what makes the same statement produce
  the same transactions whichever format it arrives in. The text primitives every path reaches
  through that seam live in `csv.ts`.
- **The sentences a refused import is explained by**, composed here and cut to the budget the data
  layer keeps.
- **The per-format ceiling on what may be held in memory at once**, `SIZE_CAP` in `statement.ts`.

It does not own the transport cap on an upload, the multipart handling or the route that receives
them — those are `backend/src/app.ts`'s — and it does not own the commit.

**Deduplication is the caller's, not the parser's.** A statement row carries no bank reference, so
no parser here supplies a dedup key and the insert computes one from the row's stable fields. That
requires the whole file to be inserted in one call, which is why the parsed rows of a whole
statement are held in memory at once and why `MAX_DATA_ROWS` in `sheet.ts` aborts an import rather
than truncating it: a statement covers whole days, so every group of identical rows arrives
complete, and a half-imported statement reported as a success is worse than a refusal.

**The order the import row, the parse and the document store are written in is load-bearing.** Hash
and check before parsing, so a re-upload costs nothing; write the import row before touching
anything else, so a failure leaves a failed import rather than nothing at all. That row is
deliberately not in a transaction with the parse — a rollback would take the failure record with it
— and the catch is around the staging as well as the parse, because a throw after some rows have
been staged leaves them attached to a failed import, which is recoverable where leaving them
unattributed would not be.

**Which refusals leave an `imports` row is a rule every future refusal site owes.** What leaves no
row at all is everything decidable without opening the file: a type the sniffer recognises and
refuses, a file past the size cap, a preset that does not exist. Nothing was parsed and nothing
could have been written, and `failed` means "an import did not complete", not "the user picked the
wrong file". What does leave a failed row is everything the loader has to open the file to
discover — a zip that turns out not to be a workbook, a sheet with no header, a PDF that is
password-protected, past the page cap or still being read at the deadline — because the bytes alone
cannot tell. It is the opening that decides the band and not how much was parsed: an encrypted PDF
parses nothing either.

**A parse cannot be interrupted, and that is a rejected design rather than an oversight.** The
deadline in `statement.ts` bounds accidental pathology and not somebody who is trying: closing that
needs an execution context that can be terminated, which is a second thread, and this process has
one. What makes that acceptable is who can upload. On the default loopback bind it is the person at
the machine, so what the deadline bounds is a bad file of their own; a wider bind puts everyone on
the network on the port, and `SECURITY.md` says so beside the setting that opens it.

## Boundary

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

**The PDF reader's globals are installed before pdfjs is loaded, and the reason the stubs exist at
all is a dependency fact.** pdfjs takes its `DOMMatrix` and `Path2D` from a canvas package it lists
as optional, which `npm` installs where a prebuilt binary exists for the machine and skips in
silence everywhere else: a renderer far larger than the text-layer parser that needs it, for a path
that reads a text layer and never draws. Without those globals the pdfjs module does not merely
warn — it constructs a matrix at module scope, so it fails to evaluate, and through the static
chain from `backend/src/app.ts` through `statement.ts` into `pdf.ts` that is a process that cannot
start, on exactly the machines the package skipped. `pdfjsloader.ts` is the mechanism; the
ordering invariant that keeps it working is stated there, where deleting a line is what breaks it,
and `backend/test/canvasabsent.test.ts` holds it in a spawned child where the package is made
unresolvable, because on a machine that has the package every other test is green whether the
stubs landed in time or not.

## The seam every frontend hands its rows to

`Sheet` in `sheet.ts` is the contract, and its fields are obligations a frontend owes rather than
conveniences it may fill in. Whoever writes a fourth frontend reads this; nobody writes one while
looking at `sheet.ts`.

- **`rows` is the header row first, with blank rows already dropped.** A row carrying nothing but
  formatting never reaches the mapper's counts, and dropping it is the frontend's job.
- **`rowLabel` is what to call a row in a problem message** — the sheet row for a workbook, the line
  for a CSV. Its **width** is an input to the diagnostic budget below, so a frontend whose labels
  can run wider than the paths measured there changes what every reason may spend.
- **`note` is why the frontend blanked a cell** — a formula the writer cached no result for, an
  error value — so the mapper can report that instead of "could not parse the amount". No preset
  will ever fix a workbook whose amounts were never computed.
- **`notices` are facts about the file that the mapper cannot see and the user has to be told
  anyway**, a sheet that was never read among them. They reach `problems` ahead of the row-level
  ones: they are facts about the file, not rejected rows.
- **A cell is not text.** A CSV row is an array of strings; a workbook row is not — a date cell
  arrives as a date and an amount cell as a float, and running either back through the text parsers
  throws away what the file already knew. So the mapper works on the cell type and each accessor
  takes the branch the cell dictates. An array of strings is assignable to an array of cells, which
  is why the CSV path still reaches exactly the functions it always did with exactly the same
  arguments.
- **A workbook cell is normalised by type and never through the renderer exceljs offers**, which
  writes a date the way the platform's own conversion does. A formula's cached result is normalised
  in turn: a computed amount column is common in bank exports and has to stay a number.
- **The header scan's predicate is the mapper's own column resolution, called through one
  function.** A scan with a laxer predicate settles on a row above the real header, and the mapper
  then reads every data row against the wrong columns and reports a plausible-looking count as a
  success. The scan is in `xlsx.ts`, the resolution in `statement.ts`, and calling one function is
  what stops them disagreeing.

**A parser version is bumped by an edit that would parse an existing file differently, and "here" is
not only the file the constant sits in.** A workbook's columns are resolved by the presets in
`csv.ts` and the resolution in `statement.ts`, so a change to either parses an existing workbook
differently for exactly the same reason and moves the XLSX number too. The invariant below states
which direction of this is held.

## What a CSV preset is, and what its author owes

A bank ships one export in every language its app offers, so each column of a preset is a list of
accepted names and its row filter a set of accepted values, and the file's header decides which of
them a given file uses. Candidate order breaks a tie, so a more specific name goes first.

- **Every accepted name comes from a header somebody has actually had in front of them.** A guessed
  translation that is wrong costs nothing; one that is exactly right for a *different* column is a
  silent mis-mapping, and a list that looks complete makes the next failure harder to read. Coverage
  grows one line at a time, from real files.
- **`description` is a list of lists, and the nesting is the point**: the outer list is the join
  order, the inner one the names accepted for that column. Flattened, the two meanings would sit a
  field apart in a type a Zod schema mirrors by hand, and a second accepted name added to a
  two-column description would silently start joining three columns instead of two.
- **The delimiter, the date format and the decimal separator stay scalar**, because the reader
  resolves the delimiter before any header exists and there would be nothing to resolve a list
  against.
- **`fee` is declared by a preset and can be supplied by nothing else** — not the generic mapper,
  not a request. Whether a column means "on top of" or "included in" the amount is a fact about a
  file a human has read, and a guessed fee column that the bank in fact already includes in its
  amount is subtracted a second time on every row of every file from that bank, in silence, with no
  reconciliation gate on that path to notice. The generic candidate list therefore carries no fee at
  all, and that absence is not an omission to tidy up.
- **`balance` is declared by a preset for the inverse reason**, and the two are worth holding side
  by side: a guessed fee column corrupts silently, where a guessed balance column *refuses* a file
  that imports today — on the one path every uncovered user is told to fall back to. The series
  column is nested inside the balance column rather than sitting beside it so that a series without
  a balance cannot be spelled: it would have no reader at all.
- **The hash is over the raw bytes and never over the decoded text**, so the encoding the decoder
  settled on cannot change whether an upload is recognised as one already imported.

## What a PDF template is, and what its author owes

A PDF has glyphs at coordinates, handed back in the order the generator drew them, which is not the
order they are read in: two columns of a statement interleave in the text array, and a row assembled
from array position gives a transaction whose amount belongs to its neighbour — parsed, accepted,
plausible and wrong. So the reader groups by coordinate and never by position.

- **Which coordinate means which column is a template, per layout rather than per bank, and there is
  no way to derive one.** It is measured off a document somebody has had in front of them, and
  **nothing in this repository checks a template against a second document.**
- **A layout no template matches is refused by name rather than read against the nearest fit.** The
  choice is made over all templates and never at the first that matches: one that matches too
  eagerly reports plausible numbers, which is the one outcome worse than a refusal.
- **A field an author could not find is written as a named "no", never left out.** An optional span
  spells "this layout prints none" and "the author did not look" the same way, and the second is
  what ships a categorisation silently worse than it could be. **The opening and closing balances
  have no such variant at all**: that is what would let an author who could not find the box write it
  away, and the weakest parser in the product would then ship with its only check switched off by a
  data literal — on exactly the layouts whose author was least sure of what they were reading. A
  document that does not state its balances is refused by simply not being a template. The per-side
  totals inside that box are the one exception, and they have a named "this layout prints none" arm
  for a reason the rule itself gives: a document that prints no per-side totals still states the two
  balances the gate checks, so writing that "no" switches nothing off.
- **A fee taken on top of the amount is not writable in a PDF template**, and the omission is
  deliberate rather than an unfinished vocabulary. The sheet path already carries both conventions,
  the two corrupt money in opposite directions, and an author who meets an on-top layout has to add
  the arm and is dragged by `tsc` into adding its case at the mapper in the same edit.
- **A continuation template states which of its labelled lines carry an account or card number,
  and the stance drives nothing.** Both continuation members of `RowExtent` carry a required
  `accountNumbers` arm, so a template that does not state one does not compile. `not-printed` says
  the layout prints no account or card number on any labelled line under a transaction. `printed`
  names, under `kept`, the labels of such lines the template appends to the description whole, and
  under `dropped`, the labels of such lines it refuses. `kept` exists because of the layout it was
  measured on: there the counterparty's account number and the counterparty's name are the same
  text item on the same line, so a rule keyed on the label or on a coordinate cannot take the number
  without taking the name — which is what a labelled keep list exists to keep — and a rule that
  reads the value's characters is refused, for the reason written beside the template whose drop
  rule was once written that way. That is the exception, and the default is the drop: where a
  layout prints an account or card number on a labelled line of its own, the template drops that
  line and declares its label under `dropped`; `kept` is for a layout where the number and the name
  are one text item. `kept` is a measurement and not a policy: it names the kept labels under which
  an account number was seen on the document the template was built from, and a kept label absent
  from it is kept whole all the same, because on a labelled layout `wanted` reads `keep` and never
  the arm. The arm drives no behaviour — `wanted` decides a continuation line off `keep` and `drop`
  alone — and it must not acquire a reader without a holder that checks it against a document,
  because a reader that trusts it inherits the gap named under the invariants below. What the
  stance is declared for is the column a kept line lands in: the categoriser, the transfer
  detector, the recurring key, the CSV export and the backup all read a stored description whole,
  so what a template appends is a decision about each of them, made per template rather than
  assumed. A stance is prospective: nothing re-parses a statement already stored and nothing
  rewrites a stored description, so a template edited today changes what the next upload stores
  and nothing already in the database.

## The diagnostic budget, and the one chain written in code

The bounds on what a refusal or a row problem may spend are **a single chain** crossing
`statement.ts`, `xlsx.ts`, `pdf.ts` and `backend/src/db/index.ts`: what the data layer keeps for an
import's error detail is what the composed sentence may spend, what that sentence's fixed prose
leaves is what a row's reason may spend, and what a reason's own prose and its row label leave is
what a frontend's note may spend.

**That chain is written whole in one place, in code, above `CELL_QUOTE_MAX` in `statement.ts`, and
it stays there.** A spec is bound by `AGENTS.md`'s delete-on-sight list, so this document cannot
carry its figures; and the chain was split across three files once, each holding a locally checkable
piece with nobody owning the sum, which is how both premises of one of those pieces came to be
false while its number stayed right. Splitting it again re-creates exactly that.

Two things about it that are the module's rather than that block's:

- **A note producer's budget is the widest-label path's, not its own.** The paths do not share a
  label width, and the two figures cannot be traded: the wider label plus the wider note composes
  past the bound, so the smaller of the two is the only figure safe on every path.
- **Nothing structurally holds a producer to it.** A note added later that spends more than its
  path's budget evicts a clause the user needed, and a blanket cut here cannot help — it would have
  to cut at the smallest figure, which is under what an existing producer already spends.

**What yields when a sentence does not fit is decided where it is composed, and there is nothing
downstream to catch it.** The client renders the whole of the budget the data layer keeps
(`MAX_ERROR_CHARS` in `web/src/api.ts`), so a clause that yields at composition time is gone rather
than merely cut further down; fixed prose is never shortened, and a refinement yields before a fact
with no other channel.

**A sheet that was never read is such a fact.** A workbook whose first month is formatted past the
early-out imports the second, answers 200 and shows a success card, and without a notice nothing the
user is shown says a month is missing — the selection loop returns at the first sheet whose header
resolves, so the same silence covers every sheet behind that one. That is why the unused list is
derived from the workbook rather than from the sheets that were tried. A log answers a support
question rather than the person looking at their own statement, and the `imports` row records
nothing about a skipped sheet at all. Hidden and empty sheets are never named: the selector will not
read a hidden sheet either, and a blank spare sheet rides along in half the workbooks people export,
so naming either puts a notice on an import with nothing wrong with it. It is **one entry however
many sheets went unread and however many causes they went unread for**, because a notice competes
for the same bounded `problems` array as every row-level message: one entry per sheet on a workbook
the importer read badly evicts the row reasons that say why. Re-uploading the file is deliberately
not offered — once an import is confirmed the same bytes answer "already imported" without being
parsed, so the only exit that works is saving the other sheets as files of their own.

## Invariants

**A parser version is not its own file's alone, and only one direction of that is written down.**
Each of the constants keyed by import source type in `statement.ts` has its current value pinned by
a literal in a check in `backend/test`, so a bump that *happens* is loud. **Nothing holds that a
bump has to happen.** The row loop runs every format through the cell readers in `sheet.ts`, which
reach the text primitives in `csv.ts` for a cell that arrives as text, and a workbook's columns
through the preset list there together with `resolveColumns` in `statement.ts` — so an edit inside
one of those files parses an existing file of another format differently and must move that
format's number too. Failing to move a number is the only direction the coupling can break in.

**The check that requires a refusal to be composed where it can be measured reads one file.**
`backend/test/refusal-set.test.ts` reads `pdf.ts` as source and requires every sentence that
importer can throw to be composed in one place, because a refusal that grows past what the data
layer keeps is invisible otherwise. `statement.ts` and `xlsx.ts` also throw refusals that reach the
same field, composed inline, and no check requires them to be composed anywhere a budget case can
find them.

**No note producer is held to its path's budget.** Stated above under the diagnostic budget, and
repeated here because it is the invariant of the two: the arithmetic is checked, the obligation on
the next producer is not.

**Nothing checks a template against a second document.** Every span is measured off one file, and a
span pointing at a neighbouring column is silent by design where the value it reads refuses nothing
and reaches no gate. What holds the spans that *can* be checked is the guard over the templates in
`backend/test/pdf.test.ts`; a layout whose second document differs is unheld by anything at all.

**A `not-printed` stance is an author's assertion, and nothing checks it against a document.** The
`accountNumbers` arm on a continuation template has the standing of `fee: { kind: 'none' }` and
`mcc: { kind: 'none' }`: a named "no" whose only holder is the person who read the document. It is
not the balances' refused shape, because a wrong "no" here switches nothing off — no code path reads
the arm, so a `not-printed` written over a layout that does print an account number costs a false
literal and nothing else. What the guard over the templates beside the spans guard holds is the
stance agreeing with the list `wanted` reads, stated per member and matched in the direction each
claim needs. Where the guard claims coverage — every line under a declared label decided by the
list — the match is `wanted`'s own and runs one way: a list entry that is a prefix of the declared
label, or the label itself, because an entry that extends the label decides only the lines that
begin with the longer entry, and to every other line under that label the list is silent. Where
the guard claims separation — a label declared one way absent from the list that sends a line the
other way, and no label declared both ways — any overlap in either direction is the contradiction.
So on a drop-list layout every label declared dropped has an entry of `drop` as its prefix and no
label declared kept overlaps one; on a keep-list layout every label declared kept has an entry of
`keep` as its prefix and no label declared dropped overlaps one; on either, no label declared kept
overlaps one declared dropped, and a `printed` stance names at least a label. And an edge across
templates: the guard carries the identifier labels as a literal of its own, holds that literal
equal to what the stances declare, and refuses any template whose `keep` or `drop` overlaps one of
them, in either direction, without declaring it — so a template whose drop list names one and
whose stance is `not-printed` is refused, whether it was cloned into that state or edited into
it. What no guard holds is the document: a layout that prints an account number under a label no
template has declared, stamped `not-printed` by an author who did not look, is green everywhere,
and only the next reader of that document corrects it.

**A fee's convention is held by `tsc`'s exhaustive switches and by nothing else.** The two
conventions move a row's amount in opposite directions, so a producer that states a fee without its
convention, or a consumer that assumes one, is money silently wrong rather than an import that
fails.

**A break refuses whatever else is true of the other runs.** The reconciliation gate refuses a file
whose links do not form one unbroken run, and it refuses the file and not the run: the file's own
arithmetic says money is missing from what was read, and a statement short by a row staged for
confirmation is the failure `AGENTS.md` ranks above a crash. One blank cell in a pocket the user
barely uses may not disarm the refusal for the account it sits beside. What keeps that from refusing
a file this parser merely reads imperfectly is that a run it cannot use is skipped rather than
examined, and the reason a skip is safe is written above `checkSheet` in `statement.ts`, where an
edit to the loop is what would break it.

**The number a person reads before confirming and the number the gate checks come out of the same
loop.** Composed separately they drift, with nothing failing until somebody reads the wrong one —
the same argument that has the new-row count come from the key generator the confirm uses.

**A diagnostic never carries an account number.** The issuer lookup in `issuer.ts` answers a name or
nothing, and never the IBAN it read the name from, because that answer is composed into
`imports.error_detail`, which is stored and read back by the person: a function that
cannot return an account number cannot leak one into a diagnostic. Its table of institutions is
hand-written entry by entry and deliberately never bulk-imported — a stale bulk table asserts a bank
that has been merged away, in the one sentence whose whole value is that the person holding the file
can check it.

**How the issuer is decided, and every clause of it was measured rather than reasoned.** A name is
asserted only when exactly one IBAN-shaped token appears on *every* page of a document of at least
two pages, and that token resolves to a directory entry. Frequency is not evidence: on the
statements this was built against the most frequent IBAN is a counterparty's, and each of them would
have named the other's bank. What repeats on every page is the account's own IBAN, because it is
page furniture, and one page cannot make a claim about repetition at all. The lookup is diagnostic
only — it runs after the template decision has already been made and cannot reach back into it.
