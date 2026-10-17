# Check My Check

**Know what you expected. See what you received. Find the difference.**

Check My Check is a personal commission tracker for SaaS account executives. Enter your annual plan, your deals, and the commission payments you actually got. The app works out what each deal should have paid, matches payments to deals, and shows which amounts need a closer look as of any date you pick.

It's a browser-only app. There's no backend, no account, no sync, and nothing gets sent anywhere.

## Getting started

Requires Node.js 20+ (built and tested on Node 22).

```bash
npm install          # installs the exact versions pinned in package-lock.json
npm run dev          # start the dev server at http://localhost:5173
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check and build a production bundle into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | TypeScript checks only |
| `npm test` | Vitest calculation, CSV, backup, and inquiry tests |
| `npm run test:e2e` | Playwright browser tests (builds and serves the app on port 4174) |

Playwright needs a Chromium browser. If you don't have one yet, run `npx playwright install chromium` first.

## How it works

1. **Plan.** One plan per calendar year: annual quota (credited revenue), base commission rate, and an optional marginal accelerator rate.
2. **Deals.** Account, credited revenue, close date, and expected payment date (plus an optional reference and notes).
3. **Payments.** Gross commission amounts with the date they were actually paid.
4. **Allocations.** Split each payment across the deals it covered, right in the payment form. For a new payment the app suggests a split (oldest due deals first, up to what's still owed on each) that you can adjust. You can split one payment across several deals, put several payments toward one deal, leave money unallocated, or allocate more than expected to record an excess receipt.
5. **Overview.** Leads with one answer (for example "You may be owed $550.00") and the deals behind it. It defaults to today; use "Change date" to look at another as-of date. "Show all the numbers" has the full breakdown:
   - **Expected by this date**: expected commission on deals whose expected payment date is on or before the as-of date
   - **Received toward that amount**: allocated payments dated on or before the as-of date toward those deals
   - **Difference to review**: the signed gap between the two
   - Expected later, received early, unallocated payments, total paid in the calendar year, and shortfalls and excess receipts listed separately, so an overpayment on one deal can't hide a shortfall on another
6. **Payroll question.** Generates a neutral, copyable message about the selected deals. It's copy only and never sends anything.

### Calculation rules

The calculation module lives in `src/lib/calc.ts`. It's pure and has its own tests.

- Money is stored as integer cents in decimal strings (`"550000"`), and rates as decimal fractions (`"0.10"`). All arithmetic uses `decimal.js`, never floating point.
- Deals are processed in commission order: close date, then same-day order (editable), then deal ID as a fixed tie-breaker.
- With an accelerator: `basePortion = min(R, max(Q − C, 0))`, `acceleratedPortion = R − basePortion`, and `expected = roundHalfUp(basePortion × b + acceleratedPortion × a)`. Without one: `expected = roundHalfUp(R × b)`. Rounding happens once per deal, to the cent.
- Quota attainment starts over each calendar year. A January payment can settle a December deal from the year before without counting toward the new year's quota.
- `difference = expected − received as of the date`. Expected commissions are always derived, never stored.

## The quick way: one drop zone

After the three plan questions (quota, base rate, accelerator), the app opens on **Add your deals and paystubs**. Drop everything there at once, or use **Choose files**: a CRM export or your own tracker (CSV or Excel, every tab), paystub PDFs, or a table-style PDF report.

- Each file, and each tab of a workbook, is recognized as **deals**, **payments**, or a **paystub**. Anything else (a Read Me tab, a monthly summary) is left out and listed.
- One review shows what was found. Day/month order is asked once if needed, and if your deals have no payout dates, you set how many days after close commission is usually paid.
- **Duplicates are skipped:** deals with a reference you already have, and paychecks with the same date and amount as one already added or in another dropped file. A tracker's paystub log plus the paystub PDFs count once.
- **Payments are matched to deals for you:** exact matches always, and best guesses (on by default) when amounts don't add up. The confirmation names the best-guess payments so you can check them.
- Next month, drop the new paystub (and an updated deals export) into the smaller drop zone under the answer.

The overview leads with the answer ("You may be owed $3,600, short on 2 deals") and an **Ask payroll about this** button. Payments, the commission plan, step-by-step imports with column matching, exports, and backups are under **Details** in the header.

## Supported plans and limitations

The app supports one plan per calendar year in USD, with a single marginal accelerator above an annual quota. It **does not** model:

- retroactive accelerators, multiple accelerator tiers, or quarterly quota resets
- split commissions, commission caps, recoverable draws, or ramp compensation
- SPIFFs or bonuses, clawbacks, or negative revenue adjustments
- midyear plan changes (an edited plan applies to the whole year)

These limits show up during plan setup, and you have to confirm your plan fits before saving. Salary and OTE aren't used. Results are only as good as the numbers you enter. The app compares figures; it isn't payroll, legal, or tax advice.

## Data storage

- Everything lives in **IndexedDB in your browser** (database `check-my-check`, store `workspaces`). Your workspace and the example workspace are stored as separate records.
- Each confirmed change is written in one IndexedDB transaction. The header shows *Saving…*, *Saved*, or *Save failed*. If a save fails, the form stays open with your entries intact.
- Each record carries a revision number. A save from an outdated tab gets rejected instead of overwriting newer data, and other open tabs reload automatically when one tab saves (via `BroadcastChannel`, plus a re-check when the window regains focus).
- **Browser data can be cleared** (clearing site data, private windows, switching browsers or devices). Export a backup regularly from **Backup & files**.

### Import and export

- **Full JSON backup and restore**: schema version, plans, deals, payments, allocations, stable IDs, and same-day order. Restores are fully validated (schema version, field formats, dangling IDs, over-allocated payments, allocations to deals that close after the payment date). You see a preview of record counts, can download your current data first, and have to confirm before anything is replaced.
- **Deal CSV import/export**: `deal_id, plan_year, account, reference, credited_revenue_usd, close_date, expected_payment_date, same_day_order, notes`
- **Payment CSV import/export**: `payment_id, payment_date, gross_commission_usd, reference, notes`. Imported payments start unallocated.
- **Allocation CSV export**: `allocation_id, payment_id, deal_id, amount_usd`
- **Reconciliation CSV export**: `as_of_date, plan_year, deal_id, account, close_date, expected_payment_date, credited_revenue_usd, expected_commission_usd, received_as_of_usd, signed_difference_usd, status`

Files in this exact format import with their IDs and same-day order kept. Imports show a preview and report errors by row, and a file with any invalid row imports nothing. Blank IDs get new UUIDs. An ID that already exists blocks the import instead of overwriting anything. Rows are never deduplicated by account name. Exported text cells that start with `=`, `+`, `-`, `@`, tab, or carriage return get an apostrophe prefix to block spreadsheet formula injection, and that prefix is removed again on import.

### Matching payments to deals automatically

Payroll usually pays several deals in one lump. **Match automatically** (on Payments, and on the Overview whenever payments are unmatched) proposes which deals each unmatched payment covered:

- **Adds up exactly:** a set of deals, expected around the payment date and with money still outstanding, sums to the payment to the cent. When several sets fit, the one with expected payment dates closest to the payment date wins.
- **Best guess:** when nothing adds up exactly, deals due by the payment date are filled closest-first (this pay cycle before older catch-up), and any deal that only partly fits is shown as partly paid. These are the payments most worth a look.
- **Where it looks:** deals expected up to 120 days before or 45 days after the payment date, never a deal that closed after the payment.
- **Review first:** every suggestion is shown first and can be unchecked, and payments that already have matches are left alone.

### PDF paystubs and statements

- **Paystubs:** pick one or several PDFs on **Import statement** (Payments). For each one we read the pay date and the current-period commission earnings lines, using the "Current" column when the earnings table has one and leaving out salary, taxes, net pay, and year-to-date figures. You review and can edit every date and amount before importing. Negative commission lines (clawbacks) are flagged, not imported. Re-importing the same paystub is caught.
- **Table-style PDF reports** (a closed-won report, a commission statement) go through the same column matching as spreadsheets. Column names repeated on each page are skipped.
- **Limits:** scanned image-only PDFs have no text to read, and the app says so. Password-protected PDFs need an unlocked copy. Paystub layouts vary a lot, so always check what was found.
- The PDF reader (pdf.js) loads only when a PDF is picked.

### Spreadsheet import (any layout)

**Import from spreadsheet** (Overview), **Import statement** (Payments), and the import buttons on **Backup & files** accept any CSV or Excel `.xlsx` file, such as a CRM opportunity export, a commission statement, or a personal tracker. Everything happens in the browser.

- **Workbooks with several tabs:** the tab that looks most like deals (or payments) is picked automatically, and you can switch tabs. Tabs with no header row, like a Read Me, aren't offered. One tracker file can feed both the deals import and the payments import.
- **Header detection:** title rows above the column names are skipped. Totals rows (starting with "Total") are skipped and listed.
- **Column matching:** columns are matched to fields automatically (for example `Account Name`, `ACV`, `Closed Won Date`, `Opportunity ID`, or `Pay Date`, `Gross Commission`). You confirm or change each match. A column with "commission" in its name is never used as deal revenue, and "net pay" is never used as gross commission.
- **Tolerant values:** money like `$60,000.00` or `USD 1,250.5`, and dates like `2026-01-10`, `1/30/26`, `Jan 10, 2026`, or `10-Jan-2026`. Excel date and number cells are read exactly, without time zone shifts or floating-point rounding.
- **Ambiguous dates:** when numeric dates could be month-first or day-first (like `01/02/2026`) and the file doesn't settle it, you're asked which, instead of the app guessing.
- **Expected payment dates:** if the file has none, or a row is blank, it's estimated as close date plus a number of days you choose (30 by default). Every deal can be edited later.
- **Re-imports:** deals with a reference or ID you already have, and payments with the same date, amount, and reference as one you already have, are skipped by default. That makes importing next month's full export safe.
- **Years without a plan:** rows from those years either block the import or, if you choose, are skipped.
- **Remembered choices:** your column matches and options are saved in this browser for each file layout, so the next import of the same layout is one click.
- **All or nothing:** any row with a problem blocks the whole import, with row numbers matching the spreadsheet. Imported payments start unallocated.
- **Not supported:** legacy `.xls` files (save as `.xlsx` or CSV), and European number formats like `1.234,56`.

## Example workspace

**Try an example** (or **View example** in the header) opens a clearly labeled sample workspace stored separately from your own. Its example date is March 31, 2026, and it shows $14,500 expected, $13,950 received, and a $550 difference (Beacon $500, Cedar $50), with $1,500 expected later. Each visit starts fresh from the original numbers. Exiting brings back your own workspace untouched.

## Project layout

```
src/lib/        pure logic: calc, ops (mutations), validate, csv, backup, inquiry, money, dates, demo
src/storage/    IndexedDB persistence and cross-tab sync
src/components/ React UI
tests/e2e/      Playwright browser tests
```
