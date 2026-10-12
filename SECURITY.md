# Security Policy

## Status

Quietpurse is **pre-release, and it runs on your own machine.** There is no hosted copy, no published
version and no upgrade path; the only data is what a person put in their own `~/Quietpurse`. Only
`main` receives fixes.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting (Security → Report a
vulnerability). Say what you did, what happened, what you expected, and which commit you ran: nothing
is hosted, so every report is against a local checkout.

## What is protected

Bank statements, on one person's disk. There is no second user for the data to leak to. What matters
is **whoever reaches the disk**, and after that **whoever reaches the port**. Against the disk, the
protection is the machine's own.

## Threat model

**Someone who reaches the disk.** Only the machine's disk encryption stands in the way: turn on
FileVault, BitLocker or LUKS. The database is a plain PGlite directory, and the statements are plain
files under `~/Quietpurse/statements` with names a person can recognise. This is a decision. The app
does not encrypt files itself, because on a personal machine the key would sit beside the files it
guards, and the point is that the files are the person's to open. Without disk encryption the
statements are readable, and Quietpurse does not warn about that at start.

**Another account on the same machine.** Partly covered, and the file modes are the smaller half.
Quietpurse creates its folders `0700` and its files `0600`. At every start it re-checks `db/` and
`statements/` and narrows either if it is wider, which also repairs an older install; `~/Quietpurse`
itself is created `0700` and not re-checked. PGlite's own files inside `db/` are covered by the
folder. **The modes do not cover the port:** on Unix, loopback is not a boundary between accounts,
so another account can reach `127.0.0.1:4000` and, with no sign-in, read and change everything. On a
single-user machine this threat does not exist; on a shared one, Quietpurse is not the right tool
today. Root, or the disk itself, gets past all of it.

**Someone who reaches the port** can read and change everything: there is no sign-in and no password,
and none is planned. The server binds `127.0.0.1` unless `QUIETPURSE_HOST` says otherwise.
`QUIETPURSE_HOST=0.0.0.0`, meant for a phone on the same Wi-Fi, opens it, and it gives the whole
network that access for as long as the app runs. Its name is the warning.

**`VITE_HOST=true` opens the data as well, and its name does not warn.** It is a development
setting, read from the environment of `npm run dev` or `npm run preview` in `web/`. That server then
listens on every interface while the app behind it stays on loopback, and it forwards `/api` with
`Host` rewritten to the app's own, so the `Host` check below passes every request it forwards. Any
device on the network can then read everything through it, the backup and the uploaded statements
included, and a client that sends no `Origin`, such as a script, can change it. A browser on
another device sends an `Origin` with every write and is refused, so a phone gets an app that reads
but cannot save. Use it only on a network you trust.

**A second Quietpurse on the same folder.** PGlite does not refuse a second opener, and two writers
corrupt it silently. So before the database opens, `backend/src/lock.ts` claims
`~/Quietpurse/quietpurse.lock` by exclusive create, and of two copies started together only one wins.
A live holder refuses the start. A lock left by a dead process is taken over, and two starts that
both find one cannot take each other's claim. A recycled pid looks like a live holder, so the refusal
also says to delete the file if that process is gone. With `DATABASE_URL` set, the server does its
own locking and no lock file is written. Migrations are applied at start, which is correct for one
process: the lock guarantees that for the built-in database. How the takeover works is in
`backend/src/SPEC.md`, under *What the process entry owes the app*.

**A web page in the person's own browser.** Loopback keeps other machines out, but not a page the
person visits. Every `/api` route passes three checks:

1. `Host` must be a loopback name (`localhost`, `::1`, `127.x`). When `QUIETPURSE_HOST` is set to
   something else, an IP address passes too, because the phone arrives by address. A DNS name is
   always refused, which closes DNS rebinding.
2. `Origin`, when present, must be a loopback name on any port, or an IP address under that wider
   bind. This closes the plain cross-origin form post, which needs no rebinding: `multipart/form-data`
   is CORS-safelisted, so the browser sends it and the write lands even though the page cannot read
   the answer. While `QUIETPURSE_HOST` is set, a page served from an IP address passes this rule;
   that configuration is open anyway.
3. A `POST`, `PUT`, `PATCH` or `DELETE` carrying `Sec-Fetch-Site` must be `same-origin`, which also
   refuses a page on this machine at another port. A browser that omits the header gets nothing from
   this check; the first two stand behind it.

`X-Frame-Options: DENY` on every response stops the app from being framed. None of this is a
password: it refuses a request from a page elsewhere, not someone who reaches the port and asks.

**A filename reaching the disk.** The uploaded filename is the first user-chosen string written
into a path, and it never reaches the disk as written. `backend/src/documents.ts` reduces it to a stem
every filesystem accepts and puts the import id after it, so no Windows device name stands alone. The
extension comes from the recognised format, never from the name. `backend/src/storage.ts` refuses any
key that reduction did not produce, rather than cleaning it. The reduction is in
`backend/src/SPEC.md`, under *What is kept of an upload, and what a crash may leave behind*.

**A file edited in the folder.** The bytes are hashed on read and refused if they differ from what
the import recorded. A statement opened in a spreadsheet and saved is not handed back as the upload.

**A crafted backup.** A restore drops unknown columns and refuses the whole backup when a value does
not fit its column. A file's name is derived from its row and never read from the backup, so a backup
names no path on this disk. And the name belongs to one row only: no row's fields can spell another
row's file, on a disk that ignores case too, so one row's delete cannot unlink another's statement.
That holds on every database, older ones included. A row's claim to a stored file is restored,
because a person's own backup on their own machine has to open their statements. When the disk
cannot honour the claim, the read refuses: it finds no file under the derived name, or bytes that do
not match the recorded hash. How the name is built is in the same section of `backend/src/SPEC.md`.

**Oversized or malicious uploads.** multer caps one upload at **25 MiB** (`MAX_UPLOAD_BYTES` in
`backend/src/app.ts`). `backend/src/providers/statement.ts` adds a 10 MiB cap for XLSX and PDF, which
are held whole while parsed, and for a PDF a 200-page limit and a 20-second deadline. None of these
bounds what a compressed stream expands to: exceljs expands a workbook whole, and the deadline cannot
interrupt a pdfjs call. They stop an accidental pathological file, not someone who is trying.

**Format confusion.** `sniff()` decides the format from the bytes, never from the filename or the
declared content type. XLSX and PDF are recognised by evidence that they are present, including a
signed container with `%PDF-` past its start. CSV is the fallback for a file that is neither, and
only for text: a UTF-16 byte-order mark makes a file CSV outright, and otherwise a file that opens
with `<`, as XML and HTML do, or has a NUL byte near its start is refused.

**A half-understood statement imported silently.** Nothing is committed on upload: rows reach
`transactions` only on an explicit `confirm`. A reconciliation gate refuses a file rather than
importing part of it.

**Duplicate or replayed imports.** `imports` is uniquely indexed on
`file_hash WHERE status = 'committed'`, so a committed file cannot be imported again silently, and a
discarded one does not block a retry.

**Statements or a database in the repository.** `.gitignore` refuses `.env*` except the
`.env.example` files, every statement format wherever it lands (`*.csv`, `*.xlsx`, `*.pdf`), the
database files of the earlier SQLite version, the lock file, and the PGlite database of a relative
`QUIETPURSE_HOME`, which resolves from `backend/`. The tree holds no secret, because the app needs
none.

## Open trade-offs

Decisions, not oversights. Plain files, an open port and the wider bind are described above.

- **A description is the statement's own text, and it goes wherever a description goes.** Of the
  detail lines a bank prints under a transaction, the parser appends the ones it keeps to the
  description, whole and unredacted. On some layouts one of them holds the counterparty's account
  number next to their name, as one line, so the number stays because the name does. On the layout
  that prints the account number on a line of its own, that line is dropped. The categoriser, the
  transfer detector, the CSV export and the backup read a description whole, so an export or backup
  the person passes on carries the number. It also outlives the file: "Delete file" in Import history
  removes the uploaded file and leaves every transaction, description included, as it was.
- **The default test run cannot see a concurrency bug.** PGlite is single-connection, so a unique
  index losing a race is exercised only when `TEST_DATABASE_URL` points at a real Postgres. CI does
  both; a local run usually does not. The product on PGlite runs on the same single connection,
  which is also why two processes on one folder is the case worth a lock.

## What Quietpurse does not do

- **It sends no financial data anywhere.** No telemetry, no analytics. The only outbound requests
  fetch exchange rates, and none carries an amount, a description or an account:
  - Frankfurter (the ECB's rates) or the NBU receive the date of a transaction in a currency other
    than the base currency, and the codes of both currencies. When the NBU published nothing for that
    date, it is also asked for the days before.
  - Monobank receives a request for its public rates that carries nothing of the person's. It is
    fetched at every re-classification, at most once every ten minutes, to check transfers across
    currencies.

  Like any request, each one shows the provider this machine's public address and the time.
- **It holds no bank credentials or API tokens.** Direct bank connections were removed; a statement
  is a file the user uploads.
- **It keeps nothing in the browser but the theme choice.** No cookie, no token, no session.
