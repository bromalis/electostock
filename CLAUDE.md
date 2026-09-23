# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ElectoStock is an electronics parts inventory tracker with multi-level BOMs (bills of materials), BOM checkout (stock deduction for builds), and a checkout log. It is two files with no build system, package manager, linter, or tests:

- `Code.gs`: a Google Apps Script backend bound to a Google Sheet. It exposes a JSON API through a Web App.
- `index.html`: a standalone single-page frontend (inline CSS and JS, no framework). It is hosted separately and is **not** served by Apps Script. It calls the Web App's `/exec` URL with `fetch`.

## Deploying / running

- **Backend:** paste `Code.gs` into the Sheet's Apps Script editor. Deploy it as a Web App with "Execute as: Me" and "Who has access: Anyone". **After any backend change you must publish a new version** (Deploy > Manage deployments > Edit > New version > Deploy). Otherwise the live `/exec` URL keeps serving the old code.
- **One-time setup (run from the Apps Script editor's function dropdown):**
  - `installOnEditTrigger()` installs the onEdit trigger so that manual edits in the sheet bump the `last_modified` value.
  - `setupUser1()`, or `createUser(username, password, role)`, creates or updates users. Users can only be created this way; the UI has no sign-up.
- **Frontend:** `SHEET_URL` near the top of the `<script>` in `index.html` holds the deployed `/exec` URL. Change it to point the UI at a different sheet or deployment. To test, open `index.html` in a browser; it talks to the live backend.

## Architecture

### API contract (spans both files)
- The client's `api(action, data)` sends **every** request as a GET with query params `?action=<name>&data=<JSON>`, including writes. `doGet` and `doPost` both route to `handleRequest`, which dispatches on `action` in a `switch`.
- **To add an endpoint:** write an `actionX` function in `Code.gs`, add a `case` to the inner switch in `handleRequest`, then call `api('x', {...})` from `index.html`.
- Responses are JSON. On failure the backend returns `{error}`, and on an auth failure `{error, auth:false}`. The client throws on `error` and sends the user back to the login screen on `auth:false`.
- All actions except `login` and `logout` require `data.token`. `api()` attaches it automatically.

### Data storage: sheets as tables
Each sheet is created on first access by its `get*Sheet()` helper. Column order is defined by the `*_HEADERS` constants at the top of `Code.gs`, and the code reads and writes cells **by column position**. So reordering or inserting a column means updating those constants, `rowToInvObj`, and any hard-coded column indexes (for example, the auth code uses columns 4 and 5 for token and expiry).
- `Inventory`: items. `id` is a numeric id that is assigned as max+1. Assemblies are ordinary inventory rows that happen to have BOM lines.
- `BOMs`: flat `parent_id, child_id, quantity` rows. Saving a BOM overwrites every line for that parent. Deleting an item also deletes every BOM row where the item is the parent or the child.
- `Categories`, `Checkout Log` (append-only, denormalized so history survives BOM changes), `Users` (SHA-256 password hash with a fixed salt, plus the session token and its 8h expiry stored in the row).
- `Meta`: holds a `last_modified` timestamp. Every write action calls `touchLastModified()`, so **new write actions must call it too**, or other clients won't notice the change.

### Sync model
- On load, the client calls `getAll+getCats`, which returns items, categories, BOMs, and the timestamp in one call. It keeps everything in global arrays (`inventory`, `categories`, `boms`).
- Every `POLL_INTERVAL_MS` (30s) the client polls `getLastModified` and runs a full silent re-sync when the timestamp has changed. Nothing else merges or diffs the data.

### BOM logic lives in the client
BOM recursion is done entirely in `index.html` against the in-memory arrays:
- `resolveBom` / `mergeBomLines` flatten a BOM to its **leaf** components only. Intermediate sub-assemblies are expanded and never deducted themselves. Every recursive function passes a `visited` set to guard against cycles.
- `calcBomCost` always recalculates from leaf `unit_cost` values. `propagateBomCosts` walks upward through ancestor assemblies and saves their recalculated `unit_cost` via `update` calls. An assembly's stored `unit_cost` is therefore a derived cache.
- Checkout (`confirmBomCheckout`) sends `batchAdjustQty` (deductions floor at 0 on the server) and `logCheckout` in parallel. A failure to log does not block the checkout.
