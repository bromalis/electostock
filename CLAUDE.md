# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ElectoStock is an electronics parts inventory tracker with multi-level BOMs (bills of materials), BOM checkout (stock deduction for builds), and a checkout log.

- `index.html`: a standalone single-page frontend (inline CSS and JS, no framework, no build step). It is served by GitHub Pages and talks to Supabase through `supabase-js`, loaded from jsDelivr and pinned with an SRI hash.
- `supabase/migrations/*.sql`: the whole backend. It contains the Postgres schema, the row-level security (RLS) policies, the triggers and the database functions.
- `scripts/import-sheet.mjs`: a one-off import from CSV exports of the old Google Sheet.
- `Code.gs`: the legacy Google Apps Script backend, bound to the old Google Sheet. It is being retired; see "Legacy Apps Script" below.
- `tests/`:
  - `tests/db/`: tests that run the migrations against PGlite (Postgres compiled to WebAssembly).
  - `tests/import.test.mjs`: tests for the import script.
  - `tests/*.test.js`: tests for the legacy `Code.gs`, run against in-memory fakes in `tests/fakes.js`.

## Commands

- Run all tests with `npm test` (`node --test`, Node 18+). Run one file with `node --test tests/db/schema.test.mjs`, or one test with `node --test --test-name-pattern="checkout"`. GitHub Actions (`.github/workflows/test.yml`) runs the tests on every push.
- `npm install` fetches the only dependency, `@electric-sql/pglite`. It is a dev dependency, used by the database tests.
- Import from the sheet: `node scripts/import-sheet.mjs <folder with the CSVs> [out.sql]`, then run the generated SQL in the Supabase SQL Editor. The script replaces all inventory data and leaves users alone. The generated SQL contains real data, so keep it out of the repo.

## Deploying

- **Frontend:** pushing to `main` publishes it on GitHub Pages at https://bromalis.github.io/electostock/. `SUPABASE_URL` and `SUPABASE_KEY` sit at the top of the main `<script>`. The key is the *publishable* key, which is public by design. Never put a `service_role` or secret key in the page.
- **Database:** migrations are applied by pasting them into the Supabase SQL Editor, once each, in filename order. Add changes as a **new** migration file; never edit one that has already been applied. `tests/db/harness.mjs` runs every file in `supabase/migrations/` in order, so the tests always cover the full chain.
- **Auth settings** live in the Supabase dashboard, not in the repo:
  - Site URL and Redirect URLs must include every page origin that sends emailed links, including `http://localhost:8765/` for local testing.
  - Email sign-ups must stay **enabled**. Invite-only is enforced by the `handle_new_user` trigger.
  - Minimum password length is 8, the same as `MIN_PASSWORD_LENGTH` in `index.html`.
- **Local testing:** serve `index.html` at `http://localhost:8765/`. It talks to the real project, so use obviously named test data and remove it afterwards.

## Architecture

### Data layer (`index.html`)
- `api(action, data)` keeps the action names and response shapes that the screens were written against. Each action in `ACTIONS` maps to a supabase-js query or an RPC call. Add new backend calls there.
- `ok()` unwraps `{data, error}` and turns Postgres errors into readable messages.
- An update or delete that RLS blocks affects zero rows **without** raising an error. Pass the result through `changed()` (together with `.select()`) so the user sees an error.
- Numeric columns are Postgres `numeric`. `toItem()` / `num()` convert them to JS numbers.

### Permissions (database)
- Roles live in `profiles.role` (`viewer` < `user` < `admin`), and every RLS policy checks them through `has_role()`. A role change takes effect on the user's next request. The page re-reads the role on every sync to update which buttons it shows (`body[data-role]` + `.needs-user` / `.needs-admin`).
- Sign-up is invite-only. `admin_invite()` stores an email and role in `invites`, and the `handle_new_user` trigger on `auth.users` rejects any email that hasn't been invited.
- `checkout_log` has no insert policy: only `checkout()` (a security definer function) writes to it.
- User admin goes through `admin_*` functions. Their guards: admins can't change their own role or delete themselves, and the `keep_one_admin` trigger ensures at least one admin always remains.
- Grants: `anon` gets nothing. `authenticated` gets table access (RLS decides) plus EXECUTE on the listed functions. New functions need an explicit `grant execute`.

### BOM logic (database is authoritative)
- `bom_lines.quantity` may be **negative, but never 0**. After merging, each component's net is one of:
  - positive: deducted;
  - zero: untouched;
  - negative: returned to stock.
  Costs can therefore also be zero or negative.
- Cost rollups are triggers. `items_before_write` recalculates an assembly's `unit_cost` from its leaves (`bom_cost()`) whenever its row is written. A change to any item's cost "touches" that item's direct parents, and the recalculation cascades all the way up. As a result, an assembly's cost can't be set by hand.
- `bom_prevent_cycles` rejects any line that would create a loop, however the line is written.
- `checkout()`, `save_bom()` and `adjust_qty()` each run as a single transaction. The checkout log keeps one row per path, including negative rows, and records `user_email`.
- `index.html` keeps its own copies of `resolveBom` / `mergeBomLines` / `calcBomCost` / `getWhereUsed` for previews, cost display, pick lists and the "Used In" panel. Keep them consistent with the SQL.

### Auth flows (`index.html`)
- supabase-js runs with `flowType: 'implicit'`. Emailed links, including invites requested from an admin's browser, must work on any device, which the default PKCE flow can't do.
- `handleAuthEvent` handles four cases:
  - `INITIAL_SESSION` / `SIGNED_IN` call `startSession`, which loads the role, runs the first sync and starts live updates.
  - `PASSWORD_RECOVERY` opens the password dialog in `recovery` mode.
  - A user without `user_metadata.password_set` (someone who arrived from an invite link) gets the dialog in `first` mode.
- Changing your own password first re-checks the current password with `signInWithPassword`, then calls `updateUser`, then signs out other devices.
- After a successful password sign-in or password change, `offerToSavePassword` triggers Chrome's save/update prompt.

### Live updates
- A realtime channel on `items`, `bom_lines` and `categories` triggers a debounced silent `syncAll`. The page doesn't poll. `syncAll` queues a second run if a change arrives while a sync is already in progress.

### Theme
- Colours are CSS custom properties on `:root` (dark), overridden by `:root[data-theme="light"]`. Use the tokens rather than hard-coded colours; the printed pick list is the exception and stays black on white.
- A script in `<head>` sets `data-theme` before first paint, from the saved `electostock_theme` value or the device setting.
- Format money with `fmtMoney` so negative values read `−$0.50`.

## Legacy Apps Script

`Code.gs` and its clasp setup (`.clasp.json`, `.claspignore`, `appsscript.json`, and the `push` / `deploy` npm scripts) belong to the old Google Sheet backend. `clasp push` replaces the whole online project, and clasp may need `clasp login` again whenever Google Workspace asks you to sign in again.
