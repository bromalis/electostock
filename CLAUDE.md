# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ElectoStock is an electronics parts inventory tracker with multi-level BOMs (bills of materials), BOM checkout (stock deduction for builds), and a checkout log.

- `index.html`: a standalone single-page frontend (inline CSS and JS, no framework, no build step). It is served by GitHub Pages and talks to Supabase through `supabase-js`, loaded from jsDelivr and pinned with an SRI hash.
- `assets/`:
  - the Aerolab logo shown in the sidebar, on the login screen and on the printed pick list (`aerolab-logo.png`, trimmed and scaled to 480 px wide);
  - the browser-tab icon (`favicon-32.png`, the logo's "A" on a transparent square) and the home-screen icons: `apple-touch-icon.png` (iPhone) and `icon-192.png`, `icon-512.png` and `icon-maskable-512.png` (Android), all the same "A" on white;
  - `manifest.webmanifest`, which makes the page installable as an app ("Add to Home Screen");
  - `scan-codes.js`, the pure logic for reading scanned codes and matching them to items. It is the one script kept out of `index.html`, so `tests/scan-codes.test.mjs` can load it.
- `supabase/migrations/*.sql`: the whole backend. It contains the Postgres schema, the row-level security (RLS) policies, the triggers and the database functions.
- `scripts/import-sheet.mjs`: a one-off import from CSV exports of the old Google Sheet.
- `Code.gs`: Apps Script bound to the old Google Sheet. It keeps a read-only copy of the data there, refreshed hourly, and answers any old copy of the app with "moved". It is deployed with clasp; `.clasp.json`, `.claspignore` and `appsscript.json` belong to it. See "Google Sheet copy" below.
- `tests/`:
  - `tests/db/`: tests that run the migrations against PGlite (Postgres compiled to WebAssembly).
  - `tests/import.test.mjs`: tests for the import script.
  - `tests/scan-codes.test.mjs`: tests for `assets/scan-codes.js`, with real-format Digi-Key, Mouser and LCSC label contents.
  - `tests/sheet-copy.test.mjs`: runs `Code.gs` against stand-ins for the Apps Script services, feeding it a real snapshot from PGlite.

## Commands

- Run all tests with `npm test` (`node --test`, Node 18+). Run one file with `node --test tests/db/schema.test.mjs`, or one test with `node --test --test-name-pattern="checkout"`.
- `npm install` fetches the only dependency, `@electric-sql/pglite`. It is a dev dependency, used by the database tests.
- Import from the sheet: `node scripts/import-sheet.mjs <folder with the CSVs> [out.sql]`, then run the generated SQL in the Supabase SQL Editor. The script replaces all inventory data and leaves users alone. The generated SQL contains real data, so keep it out of the repo.

## Deploying

- **Workflow:** `main` is the only long-lived branch, and pushing to it deploys. For anything non-trivial, work on a branch: pushing it runs the tests without deploying. Merge into `main` when ready, then delete the branch.
- **Pipeline** (`.github/workflows/deploy.yml`): every push runs the tests. On `main`, if they pass, two more jobs run:
  1. `database` runs `supabase db push`, which applies any migrations in `supabase/migrations/` the project hasn't run yet.
  2. `pages` publishes `index.html` and `assets/` to GitHub Pages at https://bromalis.github.io/electostock/, and nothing else from the repo. Anything else the page needs at runtime must be added to the "Collect the site" step.
  The database job uses the repository secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`.
  - GitHub Pages is set to Source: GitHub Actions, so only this workflow publishes the site. A push whose tests fail changes nothing live.
  - The Supabase access token expires. When the `database` job starts failing on authentication, generate a new token in Supabase (Account > Access Tokens, scoped to the project) and update the secret.
  - Pushing a change to `.github/workflows/` needs a GitHub login with the `workflow` scope. On this machine, the git credential manager's token lacks it, while the `gh` login has it. Push those changes with `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push`.
- **Migrations:** add changes as a **new** migration file named `<yyyymmddhhmmss>_<name>.sql`; never edit one that has already been applied. The database is updated a minute before the page, so migrations must keep working with the page currently live: add tables, columns and functions, and remove old ones only in a later release, once the page no longer uses them. `tests/db/harness.mjs` runs every migration in order, so the tests always cover the full chain. Don't apply migrations by pasting them into the SQL Editor: the pipeline wouldn't know they ran. If one ever is applied by hand, record it with `supabase migration repair --status applied <version>`.
- **Page config:** `SUPABASE_URL` and `SUPABASE_KEY` sit at the top of the main `<script>`. The key is the *publishable* key, which is public by design. Never put a `service_role` or secret key in the page.
- **Auth settings** live in the Supabase dashboard, not in the repo:
  - Site URL and Redirect URLs must include every page origin that sends emailed links, including `http://localhost:8765/` for local testing.
  - Email sign-ups must stay **enabled**. Invite-only is enforced by the `handle_new_user` trigger.
  - Minimum password length is 8, the same as `MIN_PASSWORD_LENGTH` in `index.html`.
  - Emailed links (invites, sign-in links, password resets) stay valid for 1 hour (Email > "Email OTP expiration" = 3600). The app's "expires in an hour" message and the email templates say the same, so update all three together. Supabase allows at most 24 hours. An expired invite isn't a problem: the account already exists, so "Email me a sign-in link" on the login screen, or "Resend invite" in the Users dialog, sends a fresh link.
  - Email goes out over custom SMTP. For now that is Gmail (`smtp.gmail.com:465`, sending as ben@aerolab.com with an app password), a stopgap until Resend on `mail.aerolab.com` is set up. Supabase's built-in sender only delivers to members of the Supabase organisation.
  - The wording of the invite, sign-in-link and reset emails lives in Authentication > Emails > Templates. First-time invites use the "Confirm signup" template, because `signInWithOtp` creates the user; existing users get "Magic Link"; resets use "Reset Password".
- **Local testing:** from the repo root, run `python -m http.server 8765` and open http://localhost:8765/. That origin is in the project's Redirect URLs, so emailed links work. The page talks to the **real** project, so use obviously named test data and remove it afterwards.
- **Keep-alive** (`.github/workflows/keepalive.yml`): the Supabase free plan pauses a project after about a week without activity. To prevent that, a daily scheduled job calls `public.ping()`, a function the anonymous role can call that only returns `'ok'`. The hourly Sheet refresh counts as activity too. A failed ping fails the job, so GitHub's failure email doubles as a daily reachability check. GitHub turns off scheduled workflows in public repos after 60 days without a push; any push re-enables it. If the project does pause, restore it from the Supabase dashboard; no data is lost.

## Architecture

### Data layer (`index.html`)
- `api(action, data)` keeps the action names and response shapes that the screens were written against. Each action in `ACTIONS` maps to a supabase-js query or an RPC call. Add new backend calls there.
- `ok()` unwraps `{data, error}` and turns Postgres errors into readable messages.
- An update or delete that RLS blocks affects zero rows **without** raising an error. Pass the result through `changed()` (together with `.select()`) so the user sees an error.
- Numeric columns are Postgres `numeric`. `toItem()` / `num()` convert them to JS numbers.

### Permissions (database)
- Roles live in `profiles.role` (`viewer` < `user` < `admin`), and every RLS policy checks them through `has_role()`. A role change takes effect on the user's next request. The page re-reads the role on every sync to update which buttons it shows (`body[data-role]` + `.needs-user` / `.needs-admin`).
- Sign-up is invite-only. `admin_invite()` stores an email and role in `invites`, and the `handle_new_user` trigger on `auth.users` rejects any email that hasn't been invited.
- `checkout_log` has no insert policy: only `checkout()` (a security definer function) writes to it. Likewise `stock_moves` is written only by `adjust_stock()`.
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
- `checkout()`, `save_bom()` and `adjust_stock()` each run as a single transaction. The checkout log keeps one row per path, including negative rows, and records `user_email`.
- `adjust_stock(id, action, qty, note)` logs every check in / check out / set to `stock_moves`, with the actual change after flooring at 0. The old `adjust_qty()` now just calls it with no note; nothing in the page uses it any more, so drop it in a later migration.
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

### Phones and scanning (`index.html`)
- One page serves desktop and phones.
  - The inventory table responds to its own width (a container query on `.main`), not the window's, so opening the detail panel counts too. It drops Notes and the row-button labels at 1400 px, Supplier at 980, then Category, the row buttons and the stock bar at 840 (rows still open the detail panel, which has every action, including Delete). At 640 px it becomes cards. Header and cell classes (`c-part`, `c-name`, …) drive this, so a new column needs one.
  - At 820 px and narrower (the window): the sidebar becomes a drawer (`openNav` / `closeNav`), the stats and alerts give way to a row of chips (`renderViewChips`: active category filters, then the views with counts) that scrolls sideways along with the sort and assembly filters, dialogs become bottom sheets with the buttons pinned, the detail panel goes full-screen, and a floating Scan button appears. Inputs are 16 px there, because iOS zooms into smaller ones. Safe-area insets keep content clear of the iPhone notch once the page is installed.
  - The sidebar scrolls as a whole when the window is short; the sync status stays pinned at its bottom.
  - Long names, part numbers and locations wrap rather than being cut off with "…".
  - An install tip (`showInstallTip`) shows on phones until the app is installed or the tip is dismissed: an Install button where Chrome offers `beforeinstallprompt` (Android), otherwise the Share > Add to Home Screen steps (iPhone).
- Installing: "Add to Home Screen" in Safari (iPhone) or Chrome (Android). There is no service worker, so the app needs a connection. On iPhone the installed app keeps its own sign-in, separate from Safari's, and emailed links always open in Safari.
- Scanning (`openScanner`): the camera through `getUserMedia`, decoded with the built-in `BarcodeDetector` where it handles QR and DataMatrix (Android's Chrome), otherwise with the `barcode-detector` ponyfill (ZXing in WebAssembly; Safari on iPhone). The ponyfill and `qrcode-generator` (labels) load on first use from jsDelivr, pinned with SRI hashes in `LIBS`. The ponyfill fetches its `.wasm` file from jsDelivr itself. Only the area inside the on-screen frame is decoded.
- USB and Bluetooth scanners that type like a keyboard work anywhere outside a text field: fast keystrokes ending in Enter count as a scan.
- `handleScan` → `ScanCodes.parseCode` / `matchItems` → the scan sheet (`scanState.view`: `item`, `choose`, `none`, `link`, `done`, `gone`). Matching order: our label's item id; then `barcode`, `supplier_part` and `part` against the label's supplier, customer and manufacturer part numbers; then names and notes containing the manufacturer part number. A bag label defaults to Check In with the label's quantity. "Link to item" stores the code in `items.barcode` (unique, blank means none).
- Our labels (`printLabels`) carry a QR code with `https://bromalis.github.io/electostock/#item=<id>` (`ScanCodes.LABEL_BASE_URL`), wherever they were printed from. Scanning one with the phone's own camera app opens the site, and `#item=` opens that item's scan sheet once the inventory has loaded.
- Stock Moves view: `stock_moves`, newest 300. It has no live updates; use Refresh.

### Theme
- Colours are CSS custom properties on `:root` (dark), overridden by `:root[data-theme="light"]`. Use the tokens rather than hard-coded colours; the printed pick list is the exception and stays black on white.
- The pick list is written into a new `about:blank` window (`writePickListToWindow`), so anything it loads, like the logo, needs an absolute URL built with `new URL(path, location.href)`. It calls `print()` on `window.onload`, which waits for images, so the logo is on the page before the print dialog opens.
- A script in `<head>` sets `data-theme` before first paint, from the saved `electostock_theme` value or the device setting.
- Format money with `fmtMoney` so negative values read `−$0.50`.

## Google Sheet copy (`Code.gs`)

- `refreshSheetCopy()` runs every hour on a time trigger, installed once with `installHourlyRefresh()`.
  - It calls `export_snapshot(p_token)` (migration `…_sheet_export.sql`) as the anonymous API role, sending the publishable key in the `apikey` header only.
  - It rewrites the Inventory, Categories, BOMs and Checkout Log tabs, keeping the old column order with any new columns appended, and protects them so only the owner can edit. It also writes an "About this copy" tab. The old backend's Users, Sessions and Meta tabs, which held password hashes, have been deleted; nothing uses them.
- The token is in Script Properties as `EXPORT_TOKEN`. The database stores only its SHA-256. A new token comes from `select public.create_export_token();` in the SQL Editor; `delete from public.export_tokens;` revokes all tokens.
- `doGet` / `doPost` return "ElectoStock has moved", so an old copy of the page still open somewhere can't write to the sheet.
- Deploy with `npm run deploy` (on Windows PowerShell, `npm.cmd run deploy`). It runs the tests, then `clasp push -f`, then updates the old web-app deployment. `npm run push` does only the upload, which is enough for the hourly refresh because triggers run the latest uploaded code. The pipeline doesn't deploy this script, so deploy it by hand whenever `Code.gs` or `appsscript.json` changes. `clasp push` replaces the whole online project, so make changes in the repo, not in the online editor. clasp may need `clasp login` again whenever Google Workspace asks you to sign in again; the error is `invalid_rapt`. Without `-f`, clasp prints "Skipping push." and exits 0, so always check what actually went live.
