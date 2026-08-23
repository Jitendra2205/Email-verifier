# Bulk Professional Email Verifier

An internal ops tool for the mycpe ONE marketing team. Upload a contact list — CSV,
Excel, Word or PDF — get back a **confidence-scored, segment-aware** verification of
every address, and export a clean send-list.

Built against `Email_Verifier_PRD.md`.

---

## The one thing to understand first

**This tool does not claim to verify mailbox-level deliverability, and it says so in
the UI.** That is the central product decision, not a shortcut.

True SMTP verification at 250K volume does not work:

- **The big providers lie.** Gmail, Outlook and Yahoo accept `RCPT TO` for addresses
  that do not exist, then bounce later. A `250 OK` from them carries no information.
- **Catch-all domains accept everything.** A large share of corporate mail servers
  accept every recipient at the domain, so a positive result is a false positive.
- **Probing at volume is itself the problem.** Opening hundreds of thousands of SMTP
  connections from one IP is indistinguishable from a dictionary attack and is a fast
  route to being blocklisted — which is precisely the outcome the tool exists to prevent.
- **Port 25 is usually blocked** outbound on cloud and residential networks, so in most
  deployments the check cannot physically run.

So instead of a binary `valid / invalid` flag that marketing cannot trust, every row
gets one of four statuses plus a 0–100 confidence score and the specific signals behind it:

| Status | Meaning | Action |
| --- | --- | --- |
| **Valid** | Syntax is correct, the domain accepts mail, nothing flagged it. | Safe to send. |
| **Risky** | Well-formed on a working domain, but the mailbox itself can't be confirmed — catch-all domain, shared role inbox, or a DNS lookup that didn't resolve. | Warm-up batch, or hold. **Not an error state.** |
| **Invalid** | Failed syntax, or the domain cannot receive mail at all. | Suppress. |
| **Disposable** | A throwaway mailbox provider. Deliverable today, gone next week. | Suppress. |

`Risky` is the whole point. Collapsing it into either bucket is what makes conventional
verifiers untrustworthy: fold it into Valid and you mail addresses that bounce; fold it
into Invalid and you delete thousands of real, reachable professionals.

**What a production version would add:** a paid verification API (ZeroBounce, Kickbox,
NeverBounce) as a fifth layer, called only for rows this tool marks Risky. Those vendors
maintain per-provider heuristics, bounce feedback loops and reputation-managed probing
IPs — things you cannot responsibly rebuild in-house. The layered architecture here is
already shaped for that: it would slot in as one more scored signal in
`server/src/verify/`, not a rewrite.

---

## Accepted file formats

| Format | How it's read | Qualification comes from |
| --- | --- | --- |
| `.csv` `.tsv` `.txt` | Streamed, never held in memory | A column you map |
| `.xlsx` | First worksheet, read whole | A column you map |
| `.docx` `.pdf` | Text extracted and scanned for addresses | One segment you pick for the whole document |

**Tabular files** (CSV/TSV/Excel) share one path: header row, column mapping, per-row
normalisation. Excel is just a different way of producing records — formula cells
resolve to their computed value, and blanks and duplicates behave identically to CSV.

**Documents** have no columns. A conference PDF or a Word attendee list has addresses
scattered through prose, so the text is extracted and scanned for anything
address-shaped, then the marketer picks one qualification that applies to every address
in that file. The same address appearing three times in a document is one contact
mentioned three times, not three rows — repeats are merged at extraction and the count
is shown on the confirm screen.

Three deliberate limits:

- **No OCR.** A scanned or image-only PDF yields no text, and the upload is rejected
  with that exact reason rather than silently producing zero rows.
- **No legacy `.xls`.** The only maintained npm library that reads the pre-2007 binary
  format is `xlsx` (SheetJS), whose registry release carries an unpatched
  high-severity prototype-pollution/ReDoS advisory — SheetJS ships the fix only through
  their own CDN, outside npm's audit trail. Not a trade worth making for a tool that
  parses files uploaded by other people; `.xlsx` covers the real cases.
- **`.txt` is treated as delimited, not prose.** It could be either and the extension
  does not say which, so it keeps its existing CSV behaviour rather than guessing.

Excel, Word and PDF are capped at **25 MB** (`MAX_BUFFERED_UPLOAD_MB`) rather than the
200 MB CSV limit: none of their libraries can stream rows from a buffer, so the whole
file is parsed in memory and a 200 MB workbook would expand to several times that.

---

## Verification layers

Run cheapest and safest first, so nothing expensive touches a row that already failed.

1. **Syntax** — RFC 5322 addr-spec, plus length limits and the malformed shapes that
   actually show up in exported lists. No network. Also suggests corrections for common
   domain typos (`gmial.com` → `gmail.com`).
2. **Domain validity (MX)** — DNS lookup confirming the domain can receive mail.
   Falls back to the implicit-MX rule (A record) per RFC 5321 §5.1, scored lower than a
   real MX. **Cached per domain** — this is the single biggest win: 250K rows typically
   collapse to a few thousand unique domains.
3. **Disposable detection** — ~350 known throwaway providers, checked in-process. No
   third-party lookup, because that would mean shipping the contact list off-box.
4. **Role accounts** — `info@`, `hr@`, `billing@`… **Flagged, never rejected.** They are
   valid mail, just low-value for a personalised campaign, so they surface as Risky for
   the marketer to decide on.
5. **Catch-all detection** — probes one address that cannot exist at the domain. If the
   server accepts it, every address at that domain becomes Risky. Requires layer 6.
6. **SMTP RCPT probe** *(opt-in, off by default)* — a real mailbox check, throttled per
   domain, with an explicit reputation warning in the UI. **A probe result can never move
   a row to Invalid on its own** — a single rejection is not trustworthy enough to delete
   a contact.

When SMTP probing is off, every row carries the reason *"Mailbox-level SMTP check not
performed"*, so nothing in the export overstates what was actually verified.

---

## Running it

Requires Node 20+.

```bash
npm install
```

Create `.env` (copy `.env.example`) and set a password hash:

```bash
npm start -- --hash "your password"
```

Paste the printed `AUTH_PASSWORD_HASH=…` line into `.env`, then:

```bash
npm run build && npm start
```

Open http://localhost:4310.

For development with hot reload (Vite on 5310, API on 4310):

```bash
npm run dev
```

Generate a realistic test list — live corporate domains, consumer mailboxes, disposable
providers, malformed addresses, role accounts, dead domains, duplicates and CSV-injection
payloads:

```bash
npm run sample
```

Run the tests:

```bash
npm test
```

---

## Architecture

```
client/                 React + Vite SPA (upload → map → progress → dashboard → export)
server/src/
  index.js              Express app, security headers, static hosting
  auth.js               Session gate, login throttling, per-endpoint rate limits
  crypto.js             AES-256-GCM encryption, blind index, scrypt passwords, shredding
  csv.js                Streaming parse, column mapping, CSV-injection sanitising
  formats/index.js      Extension -> format detection and pipeline classification
  formats/spreadsheet.js  Excel (.xlsx) reading, via exceljs
  formats/document.js   Word/PDF text extraction and address scanning
  db.js                 SQLite connection, schema, versioned migrations
  store.js              All persistence and querying, as SQL
  migrate-filestore.js  One-shot import of jobs from the pre-database version
  runner.js             Background ingest + verification, checkpointing, SSE progress
  limiter.js            Concurrency gate + per-key sliding-window rate limiter
  logger.js             PII-scrubbing structured logger
  verify/               The six layers + reference lists
```

### The database

SQLite, via `better-sqlite3`, in WAL mode. The PRD allows Postgres or SQLite; the
deciding factor was operational — SQLite needs no server, so the tool runs from a clone
and deploys as one container with a mounted volume. The SQL is ordinary and portable;
the two SQLite-specific spots are marked `SQLITE-SPECIFIC` in `db.js`.

| Table | Holds |
| --- | --- |
| `jobs` | One row per upload: status, cursor, mapping, retention, materialised counts |
| `raw_blocks` | The encrypted upload, in 4 MB blocks, deleted once ingested |
| `job_rows` | One row per contact — the encrypted address plus everything indexable |

`job_rows.status IS NULL` means "ingested, not yet verified". That single fact is what
makes the run resumable: the work remaining is a property of the data, not of any
in-memory state, so a `kill -9` costs at most the chunk that was in flight.

**What is encrypted, and what isn't.** The address and the suggested correction are
AES-256-GCM ciphertext in their columns — SQLite has no native at-rest encryption, and
those are the only genuinely personal fields. Domain, segment, status and score are in
the clear, because that is what lets the database index, filter and aggregate. A row of
`{domain, qualification, status}` identifies nobody; the same row with the local part
would. An `email_hash` column (keyed HMAC, not a plain hash) lets an exact-address
lookup compare 16 bytes per row instead of decrypting every one.

**Migrations** are versioned and run on boot (`user_version` as the register). Four have
shipped, and three of them exist because measurement contradicted the first design —
see "What the database cost, and what it bought" below.

**Counts** are materialised. They are defined as SQL aggregates and that remains the
authority, but a full recompute measured ~800ms on a 156K-row job and the progress
stream wants them several times a second. So they are maintained incrementally per
chunk and recomputed from SQL at the one point where drift is possible: a resume, which
re-verifies the chunk that was in flight when the process died. A test asserts the
incremental tally and the SQL aggregate agree exactly.

**Job processing.** Both ingest and verification run off the request cycle — the mapping
endpoint returns `202` in ~5ms and the client watches the same SSE stream for both
phases. Chunked at 1,000 rows, with the cursor checkpointed at most every 500ms or 10
chunks, bounding crash-redo to about a second of work.

**Yielding.** `better-sqlite3` is synchronous, and once the domain cache is warm
`verifyOne` resolves without touching the network — so `await` only ever yields to the
microtask queue and the event loop's I/O phase never runs. Left alone, a whole job
executes in one long tick and the HTTP server stops answering. The runner therefore
yields a macrotask every 100 rows and after each chunk commit. Worst-case API latency
during a 416K-row run: **241ms, zero failed requests**. Without the yields, individual
requests were timing out after 10 seconds.

**Throttling.** A per-domain sliding-window limiter sits in front of both DNS and SMTP,
independent of how fast the rest of the pipeline runs. A fast pipeline hammering one
corporate mail server is exactly the behaviour that gets a sender blocklisted.

---

## Security & compliance

The PRD treats this list as real contact data belonging to professionals in a
regulated industry. Concretely:

- **Encrypted at rest, from the first second.** The upload is encrypted into AES-256-GCM
  blocks and the plaintext temp file is overwritten with random bytes and deleted
  *immediately on arrival* — before the user even sees the column-mapping screen. The
  window in which an unencrypted copy of the contact list exists on disk is milliseconds,
  not however long someone leaves the mapping tab open. Ingest then decrypts one 4 MB
  block at a time in memory, and every row lands in the database already encrypted.
- **What is deliberately *not* encrypted.** The `domain`, `qualification`, `status` and
  `score` columns are stored in the clear, because a database that cannot read its own
  columns cannot index, filter or aggregate — and those operations are the point of
  having one. A row of `{domain, qualification, status}` identifies nobody; the same
  row with the local part would. Grepping the raw database file recovers 0 addresses
  and 0 local parts, but it will show you that the list contains contacts at
  `kpmg.com`. If a threat model treats the domain list itself as sensitive, the answer
  is full-file encryption (SQLCipher) or an encrypted volume, not column-level
  encryption.
- **Retention.** Jobs auto-delete after `RETENTION_DAYS` (default 7), swept on boot and
  hourly, and are deletable on demand from the UI.
- **No PII in logs.** The logger scrubs anything email-shaped into a stable salted hash
  (`em_a1b2c3d4e5`) so two log lines about the same address still correlate without being
  readable, and blocks known PII field names outright. Aggregate counts pass through.
  Stack traces never reach the client.
- **Authenticated.** Every API route except `/api/health` and `/api/session` requires a
  session. scrypt password hashing, signed HMAC session cookie, `httpOnly` +
  `SameSite=Strict` + `Secure` in production, login throttled per IP.
- **No third-party egress.** The CSP forbids every external origin — no CDN, no fonts, no
  analytics, no error tracker. The disposable-domain list is in-repo rather than a remote
  API for the same reason. The only outbound traffic is the DNS (and optional SMTP) that
  verification inherently requires.
- **CSV injection.** Any exported cell starting with `=`, `+`, `-`, `@`, tab or CR is
  apostrophe-prefixed so Excel, LibreOffice and Sheets treat it as text.
- **Rate limits.** Per-IP on login, per-user on uploads and general API calls, and
  per-domain on outbound lookups so the tool can't be turned into a way to hammer
  arbitrary third-party mail servers.
- **CSRF.** Same-origin enforcement on state-changing requests plus the `SameSite=Strict`
  cookie.

On Windows, Node's POSIX file modes are advisory — restrict the data directory with
`icacls` (already applied to `server/data` locally). On Linux the `0o600` modes apply.

---

## Verified against the PRD's acceptance criteria

Measured on this machine against real DNS, at **416,144 rows** — well past the PRD's
250K target — plus a 156K run used for the interrupt tests:

| Criterion | Result |
| --- | --- |
| Correct segmented breakdown on a mixed test list | 416,144 rows → Valid 331,316 · Risky 28,933 · Invalid 31,875 · Disposable 24,020, summing exactly, broken out by CPA / EA / HR / Other |
| Progress visible and accurate | Row count climbs during ingest; processed/ETA/rows-per-sec during verification, ~4 SSE frames/sec |
| Throughput | 416K rows end to end in 176s (44s ingest, 131s verify). ~105s for a 250K list |
| UI stays usable during a run | Worst API latency 241ms across the whole 416K job, **0 failed requests** |
| Resumable | Hard-killed (`taskkill /F`) at chunk 52/157 with 52,000 verified. Restart recovered it as `paused` at 52/157, resumed, finished — final counts identical to the uninterrupted run, so nothing was lost or double-counted |
| Clean export excludes non-Valid | 0 non-Valid and 0 duplicate rows leaked, checked row-by-row against the full export |
| CSV injection neutralised | 0 cells left starting with a bare formula character |
| No PII in logs | 0 raw addresses across a full upload → verify → export cycle |
| Auth gate | All API routes return 401 unauthenticated |
| Addresses unreadable at rest | Grepping the raw `verifier.db` bytes recovers 0 addresses and 0 local parts; the upload is ciphertext from the moment it arrives and the plaintext temp file is shredded immediately. **Domains are deliberately readable** — see the note on what is encrypted |
| Layers 5 & 6 correctness | Catch-all detection, mailbox accept/reject, 4xx-is-inconclusive and unreachable-degrades-to-unknown, all against a local mock MTA — the suite never contacts a real mail server |

Dashboard queries on the 156K job: status filter 7ms, status + segment 16ms, reason
filter 91ms, deep pagination (page 2000) 67ms, exact-address search 179ms, substring
search 0.8s, clean export 0.7s, full 156K-row export 6.7s.

`npm test` — **55 tests**: syntax edge cases, CSV injection, segment normalisation,
header inspection, chunking, encryption round-trip and tamper detection, password
hashing, log pseudonymisation, the rate limiter, the SMTP layers against a mock MTA,
15 database tests covering the schema, at-rest encryption, filtering, pagination,
search, cascade deletion, retention, owner scoping and the resume/no-double-count
contract, and 14 format tests covering extension detection, Excel parity with CSV,
formula cells, the prose address scanner and Word/PDF extraction.

---

## Deployment

The app is a single Node process serving the built client, so any container host works
(Render, Railway, Fly.io). A `Dockerfile` and `render.yaml` are included.

**Netlify and Vercel cannot host this**, and it is worth knowing why before trying:
both are static hosting plus short-lived serverless functions, and this app needs the
opposite of all three properties.

- Verification runs for **minutes in the background after the response is sent**.
  Serverless functions are killed once they respond (10–26s ceilings).
- SQLite needs a **persistent disk**; serverless filesystems are ephemeral, so the
  database would vanish between invocations.
- Progress uses **long-lived SSE connections**, which serverless does not hold open.

Render is the shortest path since `render.yaml` is already here — but note the free
tier has no persistent disks, so a volume needs the paid Starter plan; without one,
jobs are lost on every restart. Railway and Fly.io both support volumes too.

For a quick demo without deploying, `cloudflared tunnel --url http://localhost:4310`
gives a public HTTPS URL pointing at a local instance in about 30 seconds — fine for a
live walkthrough, but it only works while that machine is running.

**If the URL is shared with anyone:** load only sample or synthetic data, never a real
contact list, and generate a fresh `AUTH_PASSWORD_HASH` for the shared instance rather
than reusing a development credential. Anyone with the link plus the login can export
every address in the database.

Set in the host's environment — never commit them:

- `AUTH_USER`, `AUTH_PASSWORD_HASH`
- `SESSION_SECRET` (32+ random bytes; sessions drop on restart without it)
- `DATA_ENCRYPTION_KEY` (32 bytes, base64 — **required** on hosts with ephemeral disks,
  otherwise a new key is generated on each boot and previous jobs become unreadable)
- `NODE_ENV=production`

Attach a persistent volume at `server/data` — that is where `verifier.db` lives, so
without it every job is lost on redeploy. `render.yaml` already declares one.

Note that most PaaS providers block outbound port 25, so `SMTP_PROBE_ENABLED` will not
work there regardless of the setting — another reason it is off by default.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4310` | HTTP port |
| `AUTH_USER` | `marketing` | Login username |
| `AUTH_PASSWORD_HASH` | — | scrypt hash from `npm start -- --hash "…"` |
| `SESSION_SECRET` | random | Session cookie signing key |
| `DATA_ENCRYPTION_KEY` | generated | base64 32-byte at-rest key |
| `RETENTION_DAYS` | `7` | Auto-delete window |
| `DB_FILE` | `server/data/verifier.db` | SQLite database location |
| `CHUNK_SIZE` | `1000` | Rows per processing chunk |
| `DNS_CONCURRENCY` | `40` | Parallel DNS lookups |
| `DOMAIN_LOOKUPS_PER_MINUTE` | `20` | Per-domain lookup ceiling |
| `SMTP_PROBE_ENABLED` | `false` | Enables layers 5 & 6 |
| `SMTP_PROBES_PER_DOMAIN_PER_MINUTE` | `3` | Per-domain probe ceiling |
| `SMTP_PORT` | `25` | Probe port (overridden only by the test mock) |
| `MAX_ROWS` | `500000` | Hard row cap per job |
| `MAX_UPLOAD_MB` | `200` | Upload size cap (CSV/TSV) |
| `MAX_BUFFERED_UPLOAD_MB` | `25` | Upload size cap for Excel, Word and PDF |

---

## What the database cost, and what it bought

The first version of this tool stored jobs as encrypted chunk files. Replacing that with
SQLite was not free, and the honest summary is that it traded raw speed for queryability
and operational safety.

**Bought:**

- Dashboard filters went from scanning and decrypting the whole job to indexed queries:
  **7–91ms** on 156K rows.
- Deleting a job is one cascading `DELETE`. The old design had orphaned-file bugs; this
  one cannot have them.
- Counts are defined as SQL aggregates, so they can always be re-derived. The file store
  hand-maintained them, and that produced two real bugs — a duplicate count that
  disagreed with itself, and a "clean list" figure that was wrong by 4,769.
- Partial results are queryable mid-run, straight out of the same tables.

**Cost:** end-to-end throughput dropped roughly 3× versus writing opaque chunk files.
Per-row encryption and index maintenance are real work, and the event-loop yields that
keep the API responsive cost throughput on purpose.

**Three of the four migrations exist because measurement contradicted the design:**

1. `row_reasons`, a properly normalised table, turned out to be **43% of the database**.
   Replaced with a bitmask column: 117 MB → 56 MB.
2. The blind index made exact search an index hit, but its keys are random by
   construction, so every insert was a random B-tree write — **12.4s of a 22.7s ingest**.
   Dropped the index, kept the column; exact search still avoids decryption.
3. Recomputing counts per progress tick cost ~800ms a time. Materialised instead.

Final: **~320 bytes per row**, 127 MB for 416K rows.

---

## Known limits

- **Single-process.** Jobs run in the web process, and `better-sqlite3` is synchronous —
  hence the explicit event-loop yields. Multi-instance would need the runner split into a
  worker, at which point Postgres becomes the right call.
- **Substring search is a bounded decrypt-scan** — it stops after 30,000 rows and says so
  in the UI. Unavoidable while the address column is encrypted; exact-address search and
  every other filter are unaffected. A production answer is a searchable-encryption
  scheme or a separate trusted search service.
- **Full exports are not paginated** — a 416K-row export streams in one response.
- **The disposable list is a static snapshot.** New throwaway domains appear constantly;
  in production this should refresh from a maintained feed on a schedule.
- **DNS cache is in-memory**, so a restart re-resolves. Deliberate: it keeps domain data
  out of persistent storage, and a cold cache costs seconds, not minutes.
- **Moving to Postgres** would mean a driver swap plus the two `SQLITE-SPECIFIC` spots in
  `db.js` (the `user_version` register and `incremental_vacuum`). Nothing else in the SQL
  is dialect-dependent.
