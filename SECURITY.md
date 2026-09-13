# Security Policy

## Status

Finto is **pre-release, and it runs on your own machine**. There is no hosted copy, no published
version and no upgrade path; the only data anywhere is what a person put in their own `~/Finto`.
`main` is the only branch that receives fixes.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). Please include what you did, what happened, and what you
expected. Since nothing is hosted, a report against a local checkout is the only kind there is —
say which commit.

## What the application is protecting

Bank statements, on one person's disk. There is no second user for the data to leak to. The threat
that matters is **whoever reaches the disk**, and after that **whoever reaches the port** — and for
the first of those the application's own duties are small and stated below, because the protection
is the machine's.

## Threat model

| Vector | Mitigation |
|---|---|
| Someone who reaches the disk | **The machine's own disk encryption, and nothing else.** The database is a plain PGlite directory and the uploaded statements are plain files under `~/Finto/statements`, under names a person can recognise. That is a deliberate reduction from the hosted product, which sealed every file with AES-256-GCM under a server key: on a personal machine the key would have sat beside the files it guarded, and a folder the person cannot open was the wrong shape for a product whose point is that the files are theirs. Turn on FileVault, BitLocker or LUKS; Finto adds no layer of its own on top of it |
| Another account on the same machine | **Partly answered, and the file modes are not the half that matters.** Finto creates every folder it owns `0700` and every file it writes `0600`, and `assertWritableDir` now re-checks the mode on every boot and narrows a folder that was created wider — an install made before that code existed is repaired rather than left open. PGlite's own files inside the database folder carry PGlite's modes, which the folder covers. **What the modes do not answer is the port.** Loopback is not a boundary between accounts on Unix: a second account on the machine can reach `127.0.0.1:4000` and there is no sign-in, so it reads and changes everything, and the row below is the honest statement of that. On a single-user machine this actor does not exist; on a shared one, Finto is not the tool for the job today. A person with root, or with the disk, is unaffected by any of it |
| Someone who reaches the port | The server binds `127.0.0.1` unless `FINTO_HOST` says otherwise, and there is no sign-in: **everyone who can reach the port can read and change everything.** Setting `FINTO_HOST=0.0.0.0` is the one way to open it, it is documented as exposing the data to everyone on the network, and nothing else in the configuration widens it |
| A second Finto on the same folder | PGlite does not refuse a second opener, and two writers corrupt the directory silently. `src/lock.ts`, called by `src/index.ts` before the database opens, claims `~/Finto/finto.lock` by exclusive create, so two Fintos started together cannot both win it. A file already there is a question about the pid inside: a live pid refuses the start and names the way out, a dead one is dropped under an exclusive marker beside the file and the claim retried, so two starts that both find it cannot each drop the other's claim. A recycled pid is indistinguishable from the real holder, which is why the refusal says to delete the file |
| A page in the person's own browser | Loopback keeps other machines off the port and does nothing about a page the person visits, which is on this machine by definition. Every `/api` route is behind one check: the `Host` header must be a loopback name (`localhost`, `::1`, `127.x`) or, when `FINTO_HOST` is set, any address literal — a DNS name of the attacker's own is refused in both configurations, which is what closes DNS rebinding; an `Origin`, when present, must name this server; and a `POST`, `PUT`, `PATCH` or `DELETE` carrying `Sec-Fetch-Site` must be `same-origin`, which closes the plain cross-origin form post that needs no rebind at all (`multipart/form-data` is CORS-safelisted, so the browser sends it and the write lands even though the answer is unreadable). `X-Frame-Options: DENY` on every response stops the app being framed. The third check is a defence a browser that omits the header does not provide; the first two stand behind it |
| A filename reaching the disk | The uploaded name is the first user-chosen string ever written into a path. `src/documents.ts` reduces it to the last path segment, drops the extension, replaces every character outside letters, marks, digits and a short list, trims dots and spaces, bounds it by code points, and puts the import id between the stem and the extension — so `CON`, `NUL` and the other Windows device names never stand alone, and the one shape a dot inside the stem can make of them is prefixed. The extension comes from the recognised format, never from the name. `src/storage.ts`'s key shape refuses anything that reduction did not produce rather than cleaning it up |
| A file edited in the folder | The bytes are hashed on read and refused if they are not the ones the import recorded; a statement opened in a spreadsheet and saved is a different file and is not handed back as the upload |
| A crafted backup | A restore filters every row down to real columns holding values the column accepts, and derives every file's name from the row rather than reading a path out of it — so a backup names no path on this disk, and the name it derives belongs to one row only. The second half is a separate property from the first and is held separately: the derived name is the stem, an `_`, and the id, and the id may not contain an `_`, so there is no pair of rows whose name and id read as each other's and whose delete would therefore unlink the other's statement. A row's claim to a stored file IS restored, because the person's own backup restored onto their own machine has to open their own statements; what answers a claim the disk cannot honour is the read, which finds no file under the derived key or finds bytes that do not hash to what the row recorded, and refuses either way |
| Oversized or malicious uploads | multer caps a single upload at **25 MiB** (`MAX_UPLOAD_BYTES` in `src/app.ts`), and `providers/statement.ts` applies a second, per-format cap plus a 200-page ceiling on PDFs — the expansion-sensitive formats are bounded after decode, not only before |
| Format confusion in the parser | `sniff()` decides the format from bytes, never the filename or the client's content type. It recognises a format on **evidence that the format is present**, never on the absence of others — including the signed-container case where `%PDF-` sits at byte 71 |
| A half-understood statement importing silently | Nothing is committed on upload. `POST /api/imports` stages; rows reach `transactions` only on an explicit `confirm`. A reconciliation gate refuses rather than importing part of a file |
| Duplicate or replayed imports | `imports` is uniquely indexed on `file_hash WHERE status = 'committed'`, so a committed file cannot be silently re-imported, while a discarded one does not block a retry |
| Statements or a database in the repository | `.gitignore` refuses `.env*`, `*.csv`, `*.pdf` and the database files outright. There is no secret anywhere in the tree because the application needs none |

## Open trade-offs

Stated because they are decisions, not oversights.

- **Stored statements are plain files.** Decided on purpose, and the first row of the table above
  is the whole of what stands in for the encryption that went. A machine without disk encryption
  holds the statements readable, and Finto does not say so at start-up.
- **A transaction's description is the statement's own text, and it goes wherever a description
  goes.** Of the detail lines a bank prints under a transaction, the ones the parser keeps are
  appended to the description whole, never redacted, and on some layouts one of them carries the
  counterparty's account number beside the counterparty's name: the two are one line and one run
  of text, so the number is kept because the name is. On the layout that prints the counterparty's
  account number on a line of its own, that line is dropped. Nothing reads a stored description as
  anything but text — the categoriser, the transfer detector, the recurring grouping, the CSV
  export and the backup all read it whole — so a backup or an export the person passes on carries
  the number with it. It also outlives the statement file: "Delete file" in Import history removes
  the uploaded file and leaves every transaction, description included, exactly as it was.
- **The port has no password, and the request check is not one.** A person who sets `FINTO_HOST=0.0.0.0`
  for a phone has given their whole network read and write access to their finances for as long as
  the app runs. The `Host`, `Origin` and `Sec-Fetch-Site` check refuses a request that came from a
  page somewhere else; it says nothing about a person who can reach the port and simply asks. The
  name of the setting is the warning; there is no password to put behind it and no plan to add one.
- **A wider bind widens the `Host` rule with it.** On the default loopback bind only a loopback
  name or address is accepted. With `FINTO_HOST` set, an address literal in either family is accepted
  too, because the phone that setting exists for arrives by address. A DNS name is refused in both,
  which is the half rebinding needs — but a page served from a public IP address, rather than from
  a name, is inside the `Origin` rule while `FINTO_HOST` is set. That is the configuration the row above
  already describes as open.
- **The default test run cannot see a concurrency bug.** PGlite is single-connection, so a unique
  index losing a race is exercised only when `TEST_DATABASE_URL` points at a real Postgres. CI does
  both; a local run usually does not. The product runs on the same single connection, which is
  also why two processes on one folder is the case worth a lock.
- **Migrations are applied at start.** Correct for one process, which the lock makes it.

## What Finto does not do

- Does not send financial data anywhere. There is no telemetry, no analytics, and no third-party
  request in the transaction path.
- Does not hold bank credentials or API tokens. Direct bank connections were removed; a statement
  is a file the user uploads.
- Outbound network access is limited to exchange-rate providers (ECB, NBU) for currency conversion.
- Does not keep anything in the browser but the theme choice. There is no cookie, no token and no
  session.
