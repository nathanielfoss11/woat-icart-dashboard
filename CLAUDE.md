# Workout Anytime — iCart Lead & Join Tracking + Dashboard

Project memory / handoff notes. No secrets are stored here (no keys, passwords, or SSH creds) — only locations, IDs, and how the system works.

## Goal
Replace the fragile Zapier→Google-Sheet iCart tracking with a durable Supabase-backed
system + a live hosted dashboard that captures **every lead and join** across all WOA
iCart checkout channels (credit-card, ACH, kiosk).

## Architecture (data flow)
1. iCart checkout on each WordPress site → the plugin generates a UUID `checkout_id` and
   **mirrors** lead + purchase events to a Supabase Edge Function (`super-api`).
2. `super-api` (receiver) canonicalizes the payload, tags **platform** from the request
   origin, and calls Postgres RPCs `ingest_lead` / `ingest_purchase` to upsert into the
   `checkouts` table.
3. A scheduled **sweep** flips stale unconverted leads (>15 min) from `lead` → `lost`.
4. **Reporting views** (unique-person, deduped) aggregate the data.
5. A `report` Edge Function serves aggregates as JSON (public, no PII).
6. A self-contained HTML **dashboard** on GitHub Pages (reports.woat.org) reads the
   `report` function and renders KPIs/charts.

## Key locations & IDs (no secrets)
- **Supabase**: project `woa-icart-tracking`, ref `vxfhxgtcwczvoewozgws`, org "Sneeze It".
  - Receiver: `/functions/v1/super-api`  (hardcoded in plugin as `ICART_SUPABASE_WEBHOOK`)
  - Report:   `/functions/v1/report`  (public; aggregates only)
- **Dashboard**: GitHub repo `nathanielfoss11/woat-icart-dashboard` (public, GitHub Pages),
  served at **https://reports.woat.org** (Cloudflare DNS: CNAME `reports` → `nathanielfoss11.github.io`,
  DNS-only/grey-cloud; HTTPS enforced). `index.html` is fully self-contained; favicon = WOA "24"
  logo embedded as a data URI.
- **Three iCart WordPress sites**, each its own **Google Compute Engine VM** (access via the
  GCE console's in-browser SSH; docroot `/var/www/html`; files owned by `www-data`):
  - `www.woat.org`   (VM `workout-anytime-cc-icart`) — credit-card checkout → platform **cc**
  - `ach.woat.org`   (VM `workout-anytime-ach-icart`) — ACH/bank-draft → platform **ach**
    (its ABC club name carries the "(ACH)" suffix, e.g. "Workout Anytime (ACH)")
  - `kiosk.woat.org` — in-club kiosk → platform **kiosk**
  - Sites do NOT SSH to each other (log into each separately).

## The plugin
- Active plugin on all 3 sites: **"iCart CM 2021 - DUPE FIX"** (folder `iCartCM-2021.dev.original`).
  The unmodified original ("iCart CM 2021", folder `iCartCM-2021.2.28` where present) is kept
  **deactivated** as instant rollback.
- Edits vs. the base plugin: one NEW file `icart-checkout-id.php`, plus edits to `iCart.php`,
  `functions.php`, `widgets/icart-checkout.php`, `widgets/icart-auto-checkout.php`,
  `widgets/icart-plan-query.php`, `widgets/icart-price-summary.php`, and 2 CSS files.
- `checkout_id` = `wp_generate_uuid4()` → globally unique, safe across all sites.
- Lead events mirror **client-side** (injected JS hooks `fetch`/`XHR`); purchase events mirror
  **server-side** (`wp_remote_get`). Config-driven (reads each site's own club settings), so the
  same folder works on every site.
- To update the plugin: on `www` (cc) zip the live `iCartCM-2021.dev.original` folder (must contain
  `icart-checkout-id.php`), then on each site wp-admin → Plugins → Add New → Upload → **Replace current
  with uploaded** (keeps it active). Rollback = reactivate the original, deactivate DUPE FIX.

## Data model (`checkouts` table)
- Cols: `checkout_id` (unique), `client` (clubName), `location` (club #), name/email/phone, `plan`,
  `recurring_price`, `contract_value`, `status` (lead/joined/lost), `lead_at`/`joined_at`/`lost_at`,
  `crm_pushed`, `platform`, `raw_lead` (full mirrored payload incl. `_raw` and `platform`), `created_at`.
- Historical imports: `h25-*` (2025, ~98,649 rows) and `h26-*` (2026 pre-go-live, ~60,830 rows);
  `crm_pushed=true` so the sweep never CRM-pushes them; `client=null`. Live rows have real UUID ids.
- Go-live on production was **2026-07-22**; 2026 history was imported only through **Jul 21** to avoid
  overlap with live data.

## Reporting = unique-person (deduped)
- Views `v_report_by_year` / `v_report_by_location` / `v_report_daily` aggregate from **`v_person_year`**.
- `v_person_year`: one row per (calendar year, email) — a person is `joined` if ANY of their entries
  that year joined (Yes beats No), else their most-recent entry; blank-email rows are kept individually.
  The raw table is untouched — dedup is purely in the views, so live data stays consistent automatically.
- Effect: 2025 ≈ 46.9% and 2026 ≈ 47% conversion (comparable). Per-submission was ≈ 34%.

## Platform tagging (cc / ach / kiosk)
- `super-api` `detectPlatform(req)`: reads `Origin`/`Referer` (browser lead events) or `User-Agent`
  (server purchase events); maps `ach.woat`→ach, `kiosk.woat`→kiosk, `woat.org`→cc; sets `rec.platform`.
- Trigger `trg_set_platform` (fn `set_platform_from_raw`), BEFORE INSERT/UPDATE, lifts
  `raw_lead->>'platform'` into the `platform` column when null. The ingest RPCs were NOT modified.
- Verified end-to-end. Historical "WORKOUT ANYTIME" rows can't be split cc-vs-kiosk retroactively
  (only 3 identifiable ach rows were backfilled). Everything **going forward** is tagged.

## Operational notes / lessons
- **Daily DB backups** are enabled. Raw rows are append-only; reporting is via views.
- **CHECK-BEFORE-DELETE rule**: before any DELETE/UPDATE on real data, run `SELECT COUNT(*)` with the
  exact same WHERE, confirm the scope, THEN execute. (A delete scoped to `email='testing@sneeze.it'`
  once removed ~90 historical rows that shared that **agency test email** — all test data, no real loss,
  but broader than intended.)
- Agency test emails use the **@sneeze.it** domain and appear throughout the historical data.

## Status
- **DONE**: checkout_id + mirror live on all 3 sites; Supabase DB + lost-join sweep + reporting views;
  `report` function; hosted dashboard at reports.woat.org (HTTPS, favicon); 2025 + 2026 history loaded;
  unique-person reporting; platform tagging live.
- **PARALLEL RUN**: new system runs alongside the old Zaps — nothing turned off, full rollback available.
- **REMAINING**:
  1. Watch/compare the parallel run for a few days.
  2. **Cutover**: build the one-step GymSales Zap, point `app_config` at it, switch off the old Zaps.
  3. Optional: add a platform (cc/ach/kiosk) breakdown/filter to the dashboard.
  4. Separate track: WordPress/Elementor modernization; move ABC credentials out of the plugin.
