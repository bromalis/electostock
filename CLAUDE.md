# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ElectoStock is an electronics parts inventory tracker with multi-level BOMs (bills of materials), BOM checkout (stock deduction for builds), and a checkout log. There is no build step, and `package.json` only holds scripts (no dependencies):

- `Code.gs`: a Google Apps Script backend bound to a Google Sheet. It exposes a JSON API through a Web App.
- `index.html`: a standalone single-page frontend (inline CSS and JS, no framework). It is hosted separately and is **not** served by Apps Script. It calls the Web App's `/exec` URL with `fetch`.
- `tests/`: Node tests that load `Code.gs` into a VM against in-memory fakes of the Apps Script services (`tests/fakes.js`).

## Commands

- Run all tests: `npm test` or `node --test` (Node 18+, no dependencies). Run one file with `node --test tests/api.test.js`, or one test with `node --test --test-name-pattern="checkout"`.
- `tests/fakes.js` implements only the Sheet, Range, Lock, Cache, Content and Utilities methods that `Code.gs` currently calls. If you use a new Apps Script method, add it there.

## Deploying / running

- **Backend:** deployed with [clasp](https://github.com/google/clasp), which must be logged in (`clasp login`). `.clasp.json` points at the live script, and `.claspignore` limits uploads to `Code.gs` and `appsscript.json`.
  - `npm run push` uploads the code without changing what the live URL serves.
  - `npm run deploy` runs the tests, uploads, then updates the live Web App deployment to a new version. The `/exec` URL stays the same.
  - `clasp push` replaces the whole online project, so edits made only in the browser editor are lost. The repo is the source of truth.
  - On Windows PowerShell, use `npm.cmd` / `clasp.cmd` if script execution is disabled.
- **Frontend:** served by GitHub Pages from the root of `main` (https://bromalis.github.io/electostock/). Pushing to `main` publishes it. `SHEET_URL` near the top of the `<script>` in `index.html` holds the deployed `/exec` URL.
- The frontend and backend share one request format. Run `npm run deploy` and push to `main` back to back.
- **One-time setup (run from the Apps Script editor's function dropdown):**
  - `installOnEditTrigger()` installs the onEdit trigger so that manual edits in the sheet bump the `last_modified` value.
  - `setupUsers()` (edit it first) or `createUser(username, password, role)` creates or updates users. Users can only be created this way; the UI has no sign-up.

## Architecture

### API contract (spans both files)
- The client's `api(action, data)` POSTs `{action, data}` as a JSON string with `Content-Type: text/plain`, which avoids a CORS preflight that Apps Script can't answer. `doGet` refuses requests so that credentials never end up in URLs.
- `handleRequest` checks the token and role, then `dispatch` routes on `action`.
- **To add an endpoint:** write an `actionX` function, add it to `ACTION_ROLES` with the minimum role it needs, add a `case` in `dispatch`, then call `api('x', {...})` from `index.html`. Actions missing from `ACTION_ROLES` are rejected.
- Responses are JSON. On failure the backend returns `{error}`, and on an auth failure `{error, auth:false}`. The client throws on `error` and sends the user back to the login screen on `auth:false`.
- Apps Script replies through a one-time redirect to `script.googleusercontent.com` that intermittently returns 404 even when the script ran. `api()` retries the reads listed in `RETRYABLE_ACTIONS`. It never retries a write, because the write may already have been applied; instead it re-syncs and shows a "may or may not have been saved" error. New read-only actions belong in `RETRYABLE_ACTIONS`; writes must not go there.

### Concurrency
- Every action that needs a role above `viewer`, plus login and logout, runs inside `withLock`: a script lock, then a `SpreadsheetApp.flush()` before the lock is released.
- Write actions read fresh sheet data inside the lock. Don't compute a write from data the client sent when the sheet already holds it.
- `update` is a partial update: only the fields present are written. The client sends only the fields that changed.

### Auth and roles
- Roles are `viewer` (read only), `user` (edit, adjust, checkout, BOMs, categories) and `admin` (also delete items and categories). An unknown role string counts as `viewer`.
- The client hides buttons with the `needs-user` / `needs-admin` classes according to `body[data-role]`, but the server is what enforces the rules.
- Password hashes are stored as `pbkdf2$<iterations>$<salt>$<hash>`. Old unsalted SHA-256 hashes still verify and are upgraded on the next login.
- Sessions live in the hidden `Sessions` sheet, one row per login, storing a SHA-256 of the token. Validated sessions are cached in `CacheService` for 10 minutes.
- A session's role is fixed at login. After editing a role in the sheet, run `createUser` for that user to force a re-login.

### Data storage: sheets as tables
Each sheet is created on first access by its `get*Sheet()` helper. Column order is defined by the `*_HEADERS` constants, and the code reads and writes cells **by column position**. So reordering or inserting a column means updating those constants and `rowToInvObj`.
- `Inventory`: items. `id` is a numeric id that is assigned as max+1 under the lock. Assemblies are ordinary inventory rows that happen to have BOM lines. `readInventory()` returns the items plus `byId` / `rowOf` maps.
- `BOMs`: flat `parent_id, child_id, quantity` rows. `saveBOM` validates the lines (rejecting self-references, duplicates and cycles) and rewrites the sheet. Deleting an item also deletes every BOM row where the item is the parent or the child.
- `Categories`, `Checkout Log` (append-only, denormalized so history survives BOM changes), `Users` (`username, password_hash, role`), `Sessions`.
- `Meta`: holds a `last_modified` timestamp. Every write action calls `touchLastModified()`, so **new write actions must call it too**, or other clients won't notice the change.

### Sync model
- On load, the client calls `getAll+getCats`, which returns items, categories, BOMs, and the timestamp in one call. It keeps everything in global arrays (`inventory`, `categories`, `boms`).
- Every `POLL_INTERVAL_MS` (30s) the client polls `getLastModified` and runs a full silent re-sync when the timestamp has changed.

### BOM logic
- The server is authoritative. The pure functions in `Code.gs` (`resolveBomLeaves`, `mergeBomLines`, `buildLogComponents`, `calcBomCost`, `findAncestors`, `validateBomLines`) are unit-tested in `tests/code.test.js`.
- A BOM flattens to its **leaf** components only. Intermediate sub-assemblies are expanded and never deducted themselves. Every recursive function carries a `visited` set.
- BOM quantities may be **negative, but never 0**. A negative line (on a component or a nested BOM) subtracts, so a sub-assembly can cancel parts that another one adds. After merging, each component's net is one of:
  - positive: deducted;
  - zero: cancels out, and the row isn't touched;
  - negative: returned to stock.
  Costs can therefore also be zero or negative.
- `checkout` resolves the BOM from the sheet, writes the log rows and applies the net stock changes (deductions floor at 0) in one locked request. The log keeps one row per path, including negative ones.
- `recalcAssemblyCosts` rewrites the stored `unit_cost` of affected assemblies after `update` (when `unit_cost` changes), `saveBOM` and `delete`. The recalculated costs come back as `cost_updates`, and the client applies them with `applyCostUpdates`.
- `index.html` keeps its own copies of `resolveBom` / `mergeBomLines` / `calcBomCost` for previews, cost display and pick lists. Keep them consistent with the server versions.
- `getWhereUsed` / `countInAssembly` in `index.html` power the detail panel's "Used In" section. It lists every assembly containing the item, directly or through sub-assemblies, with the net count per unit.
- Format money with `fmtMoney` so negative costs read `−$0.50`.

### Theme
- Colours are CSS custom properties on `:root` (dark). `:root[data-theme="light"]` overrides them. Use the tokens (`--danger-text`, `--warn-text`, `--bom`, `--on-accent`, `--overlay`, …) rather than hard-coded colours. The printed pick list is the exception and stays black on white.
- A small script in `<head>` sets `data-theme` before first paint. It uses the saved `electostock_theme` value from localStorage, or the device setting if there isn't one. `toggleTheme()` saves the choice.
