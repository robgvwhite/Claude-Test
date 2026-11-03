# VAT Registration Checker

A web tool for the tax compliance team. It checks client UK VAT numbers against
HMRC in bulk, so nobody has to look them up one at a time.

* **Bulk check.** Drop in an Excel or CSV client list. The VAT number, client
  name and reference columns are detected automatically. Every number is checked
  against HMRC, and the result is compared with the name we hold.
* **Quick check.** Check a single number.
* **Review workflow.** Exceptions (not registered, name mismatch, invalid format,
  failed checks) are flagged. A specialist can **Accept** each one or **Query
  with client**, with a note.
* **Audit log.** An append-only, SHA-256 hash-chained record of every upload,
  HMRC call, review and export, with a one-click **Verify integrity** check.
* **Evidence pack.** A per-batch Excel workbook with a summary, the results with
  HMRC consultation numbers, and the batch's audit trail. It includes the
  fingerprint of the uploaded file and the results.
* **Insights.** Registration rate, data-quality issues, review progress, team
  activity, volume over time and estimated time saved.

## Quick start

Requires **Node.js 22.5+**. It uses the built-in `node:sqlite`, so no database
server is needed.

```bash
npm install
npm start            # http://localhost:3000
```

By default it runs in **Simulation** mode. HMRC isn't called: results are
generated locally, and a banner on every page says so. To try it, upload
`public/samples/sample-clients.csv`. It produces every type of outcome.

To connect to HMRC, see **[docs/HMRC_SETUP.md](docs/HMRC_SETUP.md)**.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-reload |
| `npm test` | Unit and API tests (`node:test`) |
| `npm run build` | Syntax-check and assemble a deployable `dist/` with a `BUILD_INFO.json` of file hashes |

Docker: `docker build -t vat-checker . && docker run -p 3000:3000 --env-file .env -v vatdata:/app/data vat-checker`

## Configuration (`.env`)

See `.env.example`. The main settings are `HMRC_MODE`
(`simulation` | `sandbox` | `production`), `HMRC_CLIENT_ID`, `HMRC_CLIENT_SECRET`,
`HMRC_REQUESTER_VRN` (the firm's VRN, which enables consultation numbers) and
`TRUSTED_USER_HEADER` (set when deployed behind SSO).

## How a check works

1. **Pre-flight.** Each number is normalised (spaces, `GB`/`XI` prefixes and
   Excel `.0` are removed, and branch suffixes are handled). Numbers that aren't
   9 digits are marked *Invalid format* and **not** sent to HMRC. Numbers that
   fail the mod-97 check digit are still sent, with a "possible typo" note.
   Duplicates are checked once.
2. **HMRC lookup.** An OAuth client-credentials token is obtained and cached.
   Requests are throttled to the HMRC rate limit. 429 and 5xx responses are
   retried with back-off.
3. **Name match.** The HMRC name is compared with our client name. Legal
   suffixes and `&`/`and` are ignored, and the result is scored 0–100 as
   *match*, *partial* or *mismatch*.
4. **Record.** The result, the raw HMRC response, the consultation number and
   the user are stored, and an audit event is chained onto the log.
5. **Review.** Specialists work through the *Needs review* filter.

Batches run in the background and carry on if the user leaves the page. If the
server restarts, unfinished batches resume.

## Evidencing the checks

* **Who.** Every action records the user. In production, put the app behind
  Entra ID SSO and set `TRUSTED_USER_HEADER`, so names come from SSO instead of
  being typed in.
* **What was uploaded.** The SHA-256 of the original file is kept, so it can be
  matched to the file on the client file.
* **What HMRC said.** The raw response, processing date and consultation number
  are stored for each check.
* **Nothing changed afterwards.** Audit rows are blocked from UPDATE and DELETE
  by database triggers. Each row's hash covers the previous row's hash, so any
  edit made outside the app breaks the chain, and *Verify integrity* shows where.
  Each batch also stores a fingerprint of its final results.

## Production notes

* Host on internal infrastructure (for example Azure App Service with a
  persistent volume for `data/`) and back up `data/vat-checker.db`.
* Put SSO in front of the app. The app has no login of its own.
* Brand colours are CSS tokens at the top of `public/styles.css`. Compare them
  with the official Forvis Mazars brand guidelines and logo files, and swap in
  the official logo and typeface where licensed.

## Project layout

```
server/   index.js (entry) · app.js (HTTP API) · service.js (batches, reviews, insights)
          hmrcClient.js (HMRC API + simulator) · audit.js (hash chain) · vrn.js · nameMatch.js
          fileParser.js (xlsx/csv) · exports.js (CSV/evidence pack) · db.js (SQLite schema)
public/   index.html · styles.css · app.js (no build step) · samples/
test/     core.test.js · api.test.js
docs/     HMRC_SETUP.md
```
