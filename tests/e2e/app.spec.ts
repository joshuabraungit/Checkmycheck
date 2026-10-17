import { expect, test, type Page } from '@playwright/test';

async function answerPlanQuestions(page: Page) {
  await page.getByLabel('What’s your annual quota? ($)').fill('100000');
  await page.getByLabel('What % of each deal do you earn? (%)').fill('10');
  await page.getByLabel('Higher % once you pass quota? (optional)').fill('15');
  // What isn't supported is one click away, not a wall of text.
  await expect(page.getByText(/Splits, caps, tiers, or clawbacks\?/)).toBeVisible();
}

/** Typing path: landing, then the three plan questions, then the empty start screen. */
async function createPlan(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /You closed the deal\.\s*Did you get paid for it\?/ })).toBeVisible();
  await page.getByRole('button', { name: 'Prefer typing? Enter deals by hand' }).click();
  await answerPlanQuestions(page);
  await page.getByRole('button', { name: 'Continue →' }).click();
  // A new tracker opens on the start screen with the drop zone.
  await expect(page.getByRole('heading', { name: 'Add your deals and paystubs' })).toBeVisible();
}

async function addDeal(page: Page, account: string, revenue: string, close: string, expected: string) {
  await page.getByRole('button', { name: /^Add (deal|a deal by hand)$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a deal' });
  await dialog.getByLabel('Account name').fill(account);
  await dialog.getByLabel('Credited revenue ($)').fill(revenue);
  await dialog.getByLabel('Close date').fill(close);
  await dialog.getByLabel('Expected payment date').fill(expected);
  await dialog.getByRole('button', { name: 'Add deal' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId(`deal-row-${account}`)).toBeVisible();
  await applyPendingAsOf(page);
}

/** Dates set while on the start screen are applied once there's data to show. */
const pendingAsOf = new WeakMap<Page, string>();

async function applyPendingAsOf(page: Page) {
  const date = pendingAsOf.get(page);
  if (!date || !(await page.getByRole('heading', { name: 'Add your deals and paystubs' }).isHidden())) return;
  if (!(await page.getByText(/^As of /).first().isVisible())) return;
  pendingAsOf.delete(page);
  await setAsOf(page, date);
}

async function setAsOf(page: Page, date: string) {
  // The start screen (no deals or payments yet) has no date to set yet.
  if (await page.getByRole('heading', { name: 'Add your deals and paystubs' }).isVisible()) {
    pendingAsOf.set(page, date);
    return;
  }
  const input = page.getByLabel('As of');
  if (!(await input.isVisible())) await page.getByRole('button', { name: 'Change date' }).click();
  await input.fill(date);
}

async function backToSummary(page: Page) {
  await page.getByRole('button', { name: '← Back to summary' }).click();
  await applyPendingAsOf(page);
}

/** The step-by-step deals import lives under Details › Backup & files. */
async function dealsImport(page: Page) {
  await openSettings(page, 'Backup & files');
  return page.getByTestId('import-deals');
}

async function openSettings(page: Page, item: 'Payments' | 'Commission plan' | 'Backup & files' | 'See an example') {
  await page.getByRole('button', { name: 'Details' }).click();
  await page.locator('#settings-menu').getByRole('button', { name: item }).click();
}

test('full workflow: plan, deals, partial payment, allocation, persistence, inquiry, backup', async ({ page }) => {
  await createPlan(page);
  await setAsOf(page, '2026-06-30');
  await addDeal(page, 'Acme', '60000', '2026-01-10', '2026-02-15');
  await addDeal(page, 'Beacon', '50000', '2026-02-10', '2026-03-15');
  await addDeal(page, 'Later Co', '5000', '2026-06-01', '2026-08-15');

  await expect(page.getByTestId('expected-due')).toHaveText('$11,500.00');
  await expect(page.getByTestId('deal-row-Later Co')).toContainText('Upcoming');

  // Record a partial payment; the split across two deals is suggested in the same form.
  await openSettings(page, 'Payments');
  await page.getByRole('button', { name: 'Record payment' }).click();
  const payDialog = page.getByRole('dialog', { name: 'Record a payment' });
  await payDialog.getByLabel('Payment date').fill('2026-03-15');
  await payDialog.getByLabel('Gross commission amount ($)').fill('9000');
  await payDialog.getByLabel('Statement or reference (optional)').fill('March statement');
  // Oldest due deal is filled first; the rest goes to the next one.
  await expect(payDialog.getByRole('textbox', { name: 'Acme' })).toHaveValue('6000');
  await expect(payDialog.getByRole('textbox', { name: 'Beacon' })).toHaveValue('3000');
  // Deals closing after the payment date are not offered.
  await expect(payDialog.getByRole('textbox', { name: 'Later Co' })).toHaveCount(0);
  await payDialog.getByRole('textbox', { name: 'Beacon' }).fill('4000');
  await expect(payDialog.getByText('Allocations can’t add up to more than the payment')).toBeVisible();
  await expect(payDialog.getByRole('button', { name: 'Save payment' })).toBeDisabled();
  await payDialog.getByRole('textbox', { name: 'Beacon' }).fill('3000');
  await expect(payDialog.getByTestId('alloc-remaining')).toHaveText('$0.00');
  await payDialog.getByRole('button', { name: 'Save payment' }).click();
  await expect(payDialog).toBeHidden();
  await expect(page.getByText('Fully allocated')).toBeVisible();

  // Inspect the discrepancy.
  await backToSummary(page);
  await setAsOf(page, '2026-06-30');
  await expect(page.getByTestId('expected-due')).toHaveText('$11,500.00');
  await expect(page.getByTestId('received-due')).toHaveText('$9,000.00');
  await expect(page.getByTestId('difference')).toHaveText('$2,500.00');
  await expect(page.getByTestId('difference-explainer')).toContainText('Beacon');
  await page.getByRole('button', { name: 'Beacon, view calculation' }).click();
  const detail = page.getByRole('dialog', { name: 'Beacon' });
  await expect(detail).toContainText('$40,000.00 × 10%');
  await expect(detail).toContainText('$10,000.00 × 15%');
  await expect(detail).toContainText('$5,500.00');
  await expect(detail).toContainText('+$2,500.00');
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();

  // Reload and verify persistence.
  await page.reload();
  await setAsOf(page, '2026-06-30');
  await expect(page.getByTestId('received-due')).toHaveText('$9,000.00');
  await expect(page.getByTestId('difference')).toHaveText('$2,500.00');

  // Copy a payroll inquiry.
  await page.getByRole('button', { name: 'Ask payroll about this' }).click();
  const inquiry = page.getByRole('dialog', { name: 'Draft a payroll question' });
  await inquiry.getByLabel('Who it’s for').fill('Sam');
  await inquiry.getByLabel('Your name').fill('Jordan');
  await expect(inquiry.getByTestId('inquiry-text')).toHaveValue(/leaving a difference of \$2,500\.00/);
  await inquiry.getByRole('button', { name: 'Copy message' }).click();
  await expect(inquiry.getByText('Copied to clipboard.')).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('Hi Sam,');
  expect(clip).toContain('Beacon');
  expect(clip).toContain('Jordan');
  await page.keyboard.press('Escape');
  await expect(inquiry).toBeHidden();

  // Export a backup.
  await openSettings(page, 'Backup & files');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  const backupPath = test.info().outputPath('backup.json');
  await download.saveAs(backupPath);

  // Change data: delete a deal (its allocation returns to the payment as unallocated).
  await backToSummary(page);
  await page.getByRole('button', { name: 'Acme, view calculation' }).click();
  await page.getByRole('dialog', { name: 'Acme' }).getByRole('button', { name: 'Delete deal' }).click();
  const confirmDelete = page.getByRole('dialog', { name: 'Delete Acme?' });
  await expect(confirmDelete).toContainText('$6,000.00 allocated to it returns to the unallocated balance of 1 payment');
  await expect(confirmDelete.getByTestId('deal-impact')).toContainText('2 other deals');
  await confirmDelete.getByRole('button', { name: 'Delete deal' }).click();
  await expect(page.getByTestId('deal-row-Acme')).toHaveCount(0);
  await expect(page.getByText('Some payments need a quick look.')).toBeVisible();
  await openSettings(page, 'Payments');
  await expect(page.getByText('$6,000.00 unallocated')).toBeVisible();

  // Restore the backup.
  await openSettings(page, 'Backup & files');
  await page.locator('#restore-file').setInputFiles(backupPath);
  const restore = page.getByRole('dialog', { name: 'Restore this backup?' });
  await expect(restore).toContainText('Deals');
  await expect(restore.getByRole('button', { name: 'Restore backup' })).toBeDisabled();
  await restore.getByLabel('Replace my current data with this backup').check();
  await restore.getByRole('button', { name: 'Restore backup' }).click();
  await expect(restore).toBeHidden();
  await backToSummary(page);
  await setAsOf(page, '2026-06-30');
  await expect(page.getByTestId('deal-row-Acme')).toBeVisible();
  await expect(page.getByTestId('received-due')).toHaveText('$9,000.00');
  await expect(page.getByTestId('difference')).toHaveText('$2,500.00');
});

test('demo mode shows exact totals and never overwrites personal records', async ({ page }) => {
  await createPlan(page);
  await setAsOf(page, '2026-06-30');
  await addDeal(page, 'My Real Deal', '12345.67', '2026-03-03', '2026-04-15');

  await openSettings(page, 'See an example');
  await expect(page.getByText('Example workspace.')).toBeVisible();
  await expect(page.getByLabel('As of')).toHaveValue('2026-03-31');
  await expect(page.getByTestId('expected-due')).toHaveText('$14,500.00');
  await expect(page.getByTestId('received-due')).toHaveText('$13,950.00');
  await expect(page.getByTestId('difference')).toHaveText('$550.00');
  await expect(page.getByTestId('difference-explainer')).toContainText('Beacon: +$500.00');
  await expect(page.getByTestId('difference-explainer')).toContainText('Cedar: +$50.00');
  await page.getByText('Show all the numbers').click();
  await expect(page.locator('.stats')).toContainText('$1,500.00');
  await expect(page.getByTestId('deal-row-My Real Deal')).toHaveCount(0);

  // Edit the example.
  await addDeal(page, 'Demo Only', '1000', '2026-03-25', '2026-04-30');

  await page.getByRole('button', { name: 'Exit example' }).click();
  await expect(page.getByText('Example workspace.')).toHaveCount(0);
  await expect(page.getByTestId('deal-row-My Real Deal')).toBeVisible();
  await expect(page.getByTestId('deal-row-Demo Only')).toHaveCount(0);
  await expect(page.getByTestId('deal-row-Acme')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('deal-row-My Real Deal')).toBeVisible();

  // A fresh visit to the example starts from the original numbers.
  await openSettings(page, 'See an example');
  await expect(page.getByTestId('deal-row-Demo Only')).toHaveCount(0);
  await expect(page.getByTestId('difference')).toHaveText('$550.00');
});

test('CSV import previews, rejects invalid files atomically, and imports valid ones', async ({ page }) => {
  await createPlan(page);
  await openSettings(page, 'Backup & files');
  const bad = 'deal_id,plan_year,account,reference,credited_revenue_usd,close_date,expected_payment_date,same_day_order,notes\n,2026,Good,,100,2026-01-10,2026-02-15,,\n,2026,Bad,,abc,2026-01-10,2026-02-15,,\n';
  await page.getByTestId('import-deals').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(bad) });
  const dlg = page.getByRole('dialog', { name: /Import deals/ });
  await expect(dlg).toContainText('Nothing was imported');
  await expect(dlg).toContainText('Row 3');
  await dlg.getByRole('button', { name: 'Close' }).first().click();

  const good = 'deal_id,plan_year,account,reference,credited_revenue_usd,close_date,expected_payment_date,same_day_order,notes\n,2026,"Acme, Inc.",R1,"60,000.00",2026-01-10,2026-02-15,,"multi\nline"\n,2026,Acme,R2,500,2026-01-10,2026-02-15,,\n';
  await page.getByTestId('import-deals').setInputFiles({ name: 'good.csv', mimeType: 'text/csv', buffer: Buffer.from(good) });
  await expect(dlg).toContainText('2 deals ready to import');
  await dlg.getByRole('button', { name: 'Import 2 deals' }).click();
  await expect(page.getByText('Imported 2 deals.')).toBeVisible();

  const pays = 'payment_id,payment_date,gross_commission_usd,reference,notes\n,2026-02-15,6000,Feb,\n';
  await page.getByTestId('import-payments').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from(pays) });
  const pdlg = page.getByRole('dialog', { name: /Import payments/ });
  await expect(pdlg).toContainText('Imported payments start unallocated');
  await pdlg.getByRole('button', { name: 'Import 1 payments' }).click();

  await backToSummary(page);
  await expect(page.getByTestId('deal-row-Acme, Inc.')).toBeVisible();
  await expect(page.getByTestId('deal-row-Acme')).toBeVisible();
});

for (const viewport of [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 },
]) {
  test(`layout has no horizontal scrolling on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    const noScroll = async () => {
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(viewport.width);
    };
    await noScroll();
    await page.getByRole('button', { name: 'Try an example' }).click();
    await expect(page.getByTestId('expected-due')).toHaveText('$14,500.00');
    await noScroll();
    if (viewport.name === 'mobile') {
      // Deal rows render as labeled cards.
      const label = await page
        .getByTestId('deal-row-Beacon')
        .locator('td')
        .first()
        .evaluate((el) => getComputedStyle(el, '::before').content);
      expect(label).toContain('Expected payment');
    }
    await page.getByRole('button', { name: 'Beacon, view calculation' }).click();
    await noScroll();
    await page.keyboard.press('Escape');
    await openSettings(page, 'Payments');
    await noScroll();
    for (const item of ['Commission plan', 'Backup & files'] as const) {
      await openSettings(page, item);
      await noScroll();
    }
    await openSettings(page, 'Payments');
    await page.getByRole('button', { name: /Edit payment from March 15, 2026/ }).click();
    await noScroll();
  });
}

test('editing the plan previews old and new totals before saving', async ({ page }) => {
  await createPlan(page);
  await setAsOf(page, '2026-06-30');
  await addDeal(page, 'Acme', '60000', '2026-01-10', '2026-02-15');
  await addDeal(page, 'Beacon', '50000', '2026-02-10', '2026-03-15');
  await openSettings(page, 'Commission plan');
  await page.getByRole('button', { name: 'Edit 2026 plan' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit 2026 plan' });
  await dlg.getByLabel('Accelerator rate (%)').fill('20');
  await dlg.getByRole('button', { name: 'Review changes' }).click();
  await expect(dlg).toContainText('$11,500.00');
  await expect(dlg).toContainText('$12,000.00');
  await expect(dlg).toContainText('1 of 2');
  await expect(dlg).toContainText('does not model midyear plan changes');
  await dlg.getByRole('button', { name: 'Save plan changes' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText('20%')).toBeVisible();
});

test('a second tab picks up changes instead of overwriting them', async ({ page, context }) => {
  await createPlan(page);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByRole('heading', { name: 'Add your deals and paystubs' })).toBeVisible();
  await addDeal(page, 'From Tab One', '1000', '2026-01-10', '2026-02-15');
  await expect(other.getByTestId('deal-row-From Tab One')).toBeVisible();
  await addDeal(other, 'From Tab Two', '2000', '2026-01-11', '2026-02-15');
  await expect(page.getByTestId('deal-row-From Tab Two')).toBeVisible();
  await expect(page.getByTestId('deal-row-From Tab One')).toBeVisible();
});

test('imports a messy CRM export with column matching, ambiguous dates, and remembered choices', async ({ page }) => {
  await createPlan(page);
  await setAsOf(page, '2026-06-30');
  const crm = [
    'Closed Won Opportunities report,,,,',
    'Opportunity Owner,Account Name,Amount,Close Date,Opportunity ID',
    'Me,Acme,"$60,000.00",01/10/2026,OPP-1',
    'Me,Beacon,"$50,000.00",02/10/2026,OPP-2',
    'Total,,"$110,000.00",,',
  ].join('\n');
  const file = { name: 'opps.csv', mimeType: 'text/csv', buffer: Buffer.from(crm) };
  await (await dealsImport(page)).setInputFiles(file);
  const dlg = page.getByRole('dialog', { name: 'Import deals from a spreadsheet' });
  await expect(dlg).toContainText('using row 2 for column names');
  await expect(dlg.getByLabel('Account name (required)')).toHaveValue('1');
  await expect(dlg.getByLabel('Credited revenue (required)')).toHaveValue('2');
  // 01/10 vs 10/01 can't be told apart, so we have to choose.
  await expect(dlg.getByTestId('import-summary')).toContainText('Choose how to read dates');
  await expect(dlg.getByRole('button', { name: /^Import/ })).toBeDisabled();
  await dlg.getByLabel('January 2 (month first, US style)').check();
  await dlg.getByLabel('Expected payment date: days after close').fill('45');
  await expect(dlg.getByTestId('import-summary')).toContainText('2 deals ready · 1 skipped');
  await expect(dlg).toContainText('Feb 24, 2026'); // Jan 10 + 45 days
  await dlg.getByRole('button', { name: 'Import 2 deals' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText('Imported 2 deals.')).toBeVisible();
  await backToSummary(page);
  await expect(page.getByTestId('deal-row-Acme')).toBeVisible();
  await expect(page.getByTestId('expected-due')).toHaveText('$11,500.00');

  // Next month's export: same layout, one new deal. Choices are remembered and existing deals are skipped.
  const next = crm.replace('Total,,', 'Me,Cedar,"$20,000.00",03/20/2026,OPP-3\nTotal,,');
  await (await dealsImport(page)).setInputFiles({ ...file, buffer: Buffer.from(next) });
  await expect(dlg).toContainText('column choices from your last import');
  await expect(dlg.getByTestId('import-summary')).toContainText('1 deal ready · 3 skipped');
  await dlg.getByRole('button', { name: 'Import 1 deal' }).click();
  await backToSummary(page);
  await expect(page.getByTestId('deal-row-Cedar')).toBeVisible();
  await expect(page.getByTestId('deal-row-Acme')).toHaveCount(1);
});

test('blocks the whole import when any row has a problem', async ({ page }) => {
  await createPlan(page);
  const csv = 'Customer,ACV,Close Date\nGood,100,2026-01-10\nBad,TBD,2026-01-11\n';
  await (await dealsImport(page)).setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const dlg = page.getByRole('dialog', { name: 'Import deals from a spreadsheet' });
  await expect(dlg).toContainText('Row 3: Credited revenue “TBD” isn’t a number');
  await expect(dlg.getByRole('button', { name: /^Import/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('deal-row-Good')).toHaveCount(0);
});

test('imports deals and a payment statement from Excel files', async ({ page }) => {
  const { default: writeExcelFile } = await import('write-excel-file/node');
  const deals = await writeExcelFile([
    [{ value: 'Account' }, { value: 'Bookings' }, { value: 'Close Date' }, { value: 'Pay Date' }],
    [{ value: 'Acme' }, { value: 60000, type: Number }, { value: new Date(Date.UTC(2026, 0, 10)), type: Date, format: 'mm/dd/yyyy' }, { value: new Date(Date.UTC(2026, 1, 15)), type: Date, format: 'mm/dd/yyyy' }],
    [{ value: 'Beacon' }, { value: 50000.5, type: Number }, { value: new Date(Date.UTC(2026, 1, 10)), type: Date, format: 'mm/dd/yyyy' }, { value: new Date(Date.UTC(2026, 2, 15)), type: Date, format: 'mm/dd/yyyy' }],
  ]).toBuffer();
  const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  await createPlan(page);
  await setAsOf(page, '2026-06-30');
  await (await dealsImport(page)).setInputFiles({ name: 'deals.xlsx', mimeType: xlsxType, buffer: deals });
  const dlg = page.getByRole('dialog', { name: 'Import deals from a spreadsheet' });
  await expect(dlg.getByTestId('import-summary')).toContainText('2 deals ready');
  await expect(dlg).toContainText('$50,000.50');
  await expect(dlg).toContainText('Mar 15, 2026');
  await dlg.getByRole('button', { name: 'Import 2 deals' }).click();
  await backToSummary(page);
  await expect(page.getByTestId('deal-row-Beacon')).toBeVisible();

  const statement = await writeExcelFile([
    [{ value: 'Q1 commission statement' }],
    [],
    [{ value: 'Pay Date' }, { value: 'Gross Commission' }, { value: 'Net Pay' }, { value: 'Statement' }],
    [{ value: new Date(Date.UTC(2026, 1, 15)), type: Date, format: 'mm/dd/yyyy' }, { value: 6000, type: Number }, { value: 4100, type: Number }, { value: 'Feb' }],
    [{ value: new Date(Date.UTC(2026, 2, 15)), type: Date, format: 'mm/dd/yyyy' }, { value: 7950, type: Number }, { value: 5400, type: Number }, { value: 'Mar' }],
  ]).toBuffer();
  await openSettings(page, 'Payments');
  await page.getByTestId('import-payments').setInputFiles({ name: 'statement.xlsx', mimeType: xlsxType, buffer: statement });
  const pdlg = page.getByRole('dialog', { name: 'Import payments from a spreadsheet' });
  await expect(pdlg.getByLabel('Gross commission (required)')).toHaveValue('1');
  await expect(pdlg.getByTestId('import-summary')).toContainText('2 payments ready');
  await expect(pdlg).toContainText('Total: $13,950.00');
  await pdlg.getByRole('button', { name: 'Import 2 payments' }).click();
  await expect(page.getByText('Imported 2 payments.')).toBeVisible();
  await expect(page.getByTestId('payment-card')).toHaveCount(2);
});

test('picks the right tab of a multi-tab workbook and lets you switch', async ({ page }) => {
  const { default: writeExcelFile } = await import('write-excel-file/node');
  const date = (y: number, m: number, d: number) => ({ value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: 'mm/dd/yyyy' });
  const workbook = await writeExcelFile([
    {
      sheet: 'Read Me',
      data: [[{ value: 'How to use this tracker' }], [{ value: 'Blue text = inputs' }]],
    },
    {
      sheet: 'Deals',
      data: [
        [{ value: '2026 Commission Tracker' }],
        [],
        [{ value: 'Opportunity ID' }, { value: 'Account Name' }, { value: 'Close Date' }, { value: 'ARR' }, { value: 'Est. Commission' }, { value: 'Expected Payout Date' }],
        [{ value: 'OPP-1' }, { value: 'Acme' }, date(2026, 1, 22), { value: 60000, type: Number }, { value: 6000, type: Number }, date(2026, 2, 15)],
        [{ value: 'OPP-2' }, { value: 'Beacon' }, date(2026, 2, 11), { value: 50000, type: Number }, { value: 5000, type: Number }, date(2026, 3, 15)],
      ],
    },
    {
      sheet: 'Paystub Log',
      data: [
        [{ value: 'Pay Date' }, { value: 'Pay Period' }, { value: 'Gross Commission' }, { value: 'Net Pay (after tax)' }],
        [date(2026, 2, 13), { value: 'Jan commissions' }, { value: 6000, type: Number }, { value: 4140, type: Number }],
        [date(2026, 3, 13), { value: 'Feb commissions' }, { value: 5500, type: Number }, { value: 3795, type: Number }],
      ],
    },
  ]).toBuffer();
  const file = { name: 'tracker.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook };

  await createPlan(page);
  await setAsOf(page, '2026-06-30');
  await (await dealsImport(page)).setInputFiles(file);
  const dlg = page.getByRole('dialog', { name: 'Import deals from a spreadsheet' });
  const tabSelect = dlg.getByLabel('Which tab has your deals?');
  await expect(tabSelect.locator('option:checked')).toHaveText('Deals');
  // The Read Me tab has no header row, so it isn't offered.
  await expect(tabSelect.locator('option')).toHaveText(['Deals', 'Paystub Log']);
  await expect(dlg.getByTestId('import-summary')).toContainText('2 deals ready');
  // Switching tabs re-matches columns for that tab.
  await tabSelect.selectOption({ label: 'Paystub Log' });
  await expect(dlg.getByTestId('import-summary')).toContainText('Choose a column for: Account name');
  await tabSelect.selectOption({ label: 'Deals' });
  await dlg.getByRole('button', { name: 'Import 2 deals' }).click();
  await backToSummary(page);
  await expect(page.getByTestId('deal-row-Beacon')).toBeVisible();

  // Same file on the Payments tab lands on the paystub log.
  await openSettings(page, 'Payments');
  await page.getByTestId('import-payments').setInputFiles(file);
  const pdlg = page.getByRole('dialog', { name: 'Import payments from a spreadsheet' });
  await expect(pdlg.getByLabel('Which tab has your payments?').locator('option:checked')).toHaveText('Paystub Log');
  await expect(pdlg.getByTestId('import-summary')).toContainText('2 payments ready');
  await expect(pdlg).toContainText('Total: $11,500.00');
  await pdlg.getByRole('button', { name: 'Import 2 payments' }).click();
  await expect(page.getByTestId('payment-card')).toHaveCount(2);
});

async function importCsv(page: Page, kind: 'deals' | 'payments', csv: string, order?: 'MDY') {
  const input = kind === 'deals' ? await dealsImport(page) : page.getByTestId('import-payments');
  await input.setInputFiles({ name: `${kind}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const dlg = page.getByRole('dialog', { name: `Import ${kind} from a spreadsheet` });
  if (order) await dlg.getByLabel(/month first/).check();
  await dlg.getByRole('button', { name: new RegExp(`^Import \\d+ ${kind.slice(0, -1)}`) }).click();
  await expect(dlg).toBeHidden();
  if (kind === 'deals') await backToSummary(page);
}

test('auto-matches lump-sum payments to deals and finds the real shortfall', async ({ page }) => {
  await createPlan(page);
  await setAsOf(page, '2026-06-30');
  await importCsv(
    page,
    'deals',
    'Account,ARR,Close Date,Expected Payout Date\nAcme,60000,2026-01-20,2026-02-15\nBeacon,30000,2026-02-03,2026-03-15\nCedar,20000,2026-02-25,2026-03-15\nDelta,40000,2026-03-10,2026-04-15\n',
  );
  await openSettings(page, 'Payments');
  // Feb: Acme exactly. Mar: Beacon + Cedar exactly (Cedar crosses quota: $10k x 10% + $10k x 15%). Apr: only part of Delta.
  await importCsv(page, 'payments', 'Pay Date,Gross Commission\n2026-02-13,6000\n2026-03-13,5500\n2026-04-15,5000\n');
  await page.getByRole('button', { name: 'Match automatically' }).click();
  const dlg = page.getByRole('dialog', { name: 'Match payments to deals' });
  await expect(dlg.getByTestId('match-summary')).toHaveText('2 add up exactly · 1 best guess');
  await expect(dlg).toContainText('Beacon: $3,000.00');
  await expect(dlg).toContainText('Cedar: $2,500.00');
  // Delta: $40k, starting at $110k attainment, is all above the $100k quota: $6,000 expected.
  await expect(dlg).toContainText('Delta: $5,000.00 of $6,000.00 outstanding');
  await dlg.getByRole('button', { name: 'Match 3 payments' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText('isn’t matched to deals yet')).toHaveCount(0);
  await backToSummary(page);
  await setAsOf(page, '2026-06-30');
  await expect(page.getByTestId('received-due')).toHaveText('$16,500.00');
  await expect(page.getByTestId('deal-row-Delta')).toContainText('Partially received');
  await expect(page.getByText('Provisional')).toHaveCount(0);
});

test('imports commission from several PDF paystubs and reads a PDF statement table', async ({ page }) => {
  const { makePdf, paystub } = await import('../fixtures/makePdf');
  const feb = await makePdf([paystub('02/13/2026', '6,000.00', '6,000.00')]);
  const mar = await makePdf([paystub('03/13/2026', '5,000.00', '11,000.00')]);
  const scanned = await makePdf([[]]);
  const pdf = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/pdf', buffer });

  await createPlan(page);
  await openSettings(page, 'Payments');
  // A scanned PDF has no text and is reported plainly.
  await page.getByTestId('import-payments').setInputFiles(pdf('scan.pdf', scanned));
  await expect(page.getByRole('dialog')).toContainText('looks like a scanned image');
  await page.keyboard.press('Escape');

  await page.getByTestId('import-payments').setInputFiles([pdf('2026-02-13.pdf', feb), pdf('2026-03-13.pdf', mar)]);
  const dlg = page.getByRole('dialog', { name: 'Import commission from 2 paystubs' });
  const rows = dlg.getByTestId('paystub-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Found Commission $6,000.00');
  await expect(rows.nth(0).getByLabel('Pay date')).toHaveValue('2026-02-13');
  await expect(rows.nth(1).getByLabel('Gross commission ($)')).toHaveValue('5000');
  await dlg.getByRole('button', { name: 'Import 2 payments' }).click();
  await expect(page.getByText('Imported 2 payments from paystubs.')).toBeVisible();
  await expect(page.getByTestId('payment-card')).toHaveCount(2);

  // Importing the same paystub again is flagged.
  await page.getByTestId('import-payments').setInputFiles(pdf('2026-02-13.pdf', feb));
  await expect(page.getByRole('dialog')).toContainText('You already imported this paystub.');
  await page.keyboard.press('Escape');

  // A table-style PDF report goes through column matching for deals.
  const report = await makePdf([
    [
      [50, 40, 'Closed Won Report'],
      [50, 70, 'Account'],
      [220, 70, 'ARR'],
      [320, 70, 'Close Date'],
      [50, 85, 'Acme'],
      [220, 85, '$60,000.00'],
      [320, 85, '2026-01-20'],
    ],
    [
      [50, 70, 'Account'],
      [220, 70, 'ARR'],
      [320, 70, 'Close Date'],
      [50, 85, 'Beacon'],
      [220, 85, '$50,000.00'],
      [320, 85, '2026-02-10'],
    ],
  ]);
  await backToSummary(page);
  await (await dealsImport(page)).setInputFiles(pdf('report.pdf', report));
  const ddlg = page.getByRole('dialog', { name: 'Import deals from a spreadsheet' });
  await expect(ddlg.getByTestId('import-summary')).toContainText('2 deals ready');
  await ddlg.getByRole('button', { name: 'Import 2 deals' }).click();
  await backToSummary(page);
  await expect(page.getByTestId('deal-row-Beacon')).toBeVisible();
});

test('first visit: upload on the landing page, three questions, the answer', async ({ page }) => {
  const { default: writeExcelFile } = await import('write-excel-file/node');
  const { makePdf, paystub } = await import('../fixtures/makePdf');
  const date = (y: number, m: number, d: number) => ({ value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: 'mm/dd/yyyy' });
  const n = (v: number) => ({ value: v, type: Number });
  const tracker = await writeExcelFile([
    {
      sheet: 'Deals',
      data: [
        [{ value: '2026 Commission Tracker' }],
        [],
        [{ value: 'Opportunity ID' }, { value: 'Account Name' }, { value: 'Close Date' }, { value: 'ARR' }, { value: 'Est. Commission' }],
        [{ value: 'OPP-1' }, { value: 'Acme' }, date(2026, 1, 20), n(60000), n(6000)],
        [{ value: 'OPP-2' }, { value: 'Beacon' }, date(2026, 2, 3), n(30000), n(3000)],
        [{ value: 'OPP-3' }, { value: 'Cedar' }, date(2026, 2, 25), n(20000), n(2000)],
        [{ value: 'OPP-4' }, { value: 'Delta' }, date(2026, 3, 10), n(40000), n(4000)],
      ],
    },
    { sheet: 'Read Me', data: [[{ value: 'Blue cells are inputs' }]] },
  ]).toBuffer();
  // Paid the month after close. Feb: Acme. Mar: Beacon + Cedar ($3,000 + $2,500, Cedar crosses quota). Apr: only $5,000 of Delta's $6,000.
  const feb = await makePdf([paystub('02/13/2026', '6,000.00', '6,000.00')]);
  const mar = await makePdf([paystub('03/13/2026', '5,500.00', '11,500.00')]);
  const apr = await makePdf([paystub('04/15/2026', '5,000.00', '16,500.00')]);
  const files = [
    { name: 'my-tracker.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: tracker },
    { name: 'paystub-feb.pdf', mimeType: 'application/pdf', buffer: feb },
    { name: 'paystub-mar.pdf', mimeType: 'application/pdf', buffer: mar },
    { name: 'paystub-apr.pdf', mimeType: 'application/pdf', buffer: apr },
  ];

  await page.goto('/');
  await page.getByTestId('landing-files').setInputFiles(files);
  await expect(page.getByRole('heading', { name: 'Three quick questions about your plan' })).toBeVisible();
  await expect(page.getByText('Your files are ready. These are on your comp plan document. We’ll use them for 2026.')).toBeVisible();
  await answerPlanQuestions(page);
  await page.getByRole('button', { name: 'Show my answer →' }).click();

  // No review step: nothing needed deciding.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/^Added 4 deals and 3 payments\. Matched 3 payments to deals\. One was a best guess .*\(Apr 15, 2026\).*We assumed commission is paid about 30 days after close/)).toBeVisible();
  await setAsOf(page, '2026-06-30');
  await expect(page.getByTestId('difference')).toHaveText('$1,000.00');
  await expect(page.getByTestId('difference-explainer')).toContainText('Delta');
  await expect(page.getByText('Not final yet')).toHaveCount(0);

  // Undo takes the files back out, but keeps the plan.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('heading', { name: 'Add your deals and paystubs' })).toBeVisible();

  // Dropping them again adds them again; dropping a third time adds nothing.
  await page.getByTestId('drop-files').setInputFiles(files);
  await expect(page.getByText(/^Added 4 deals and 3 payments\./)).toBeVisible();
  await page.getByTestId('drop-files').setInputFiles(files.slice(0, 2));
  await expect(page.getByText('Nothing new to add. Those deals and paychecks are already here.')).toBeVisible();
});

test('the review only appears when there is a question to answer', async ({ page }) => {
  const { makePdf, paystub } = await import('../fixtures/makePdf');
  // 01/02 vs 02/01 can't be told apart, so we have to ask.
  const deals = 'Account,ARR,Close Date,Expected Payout Date\nAcme,60000,01/02/2026,02/03/2026\nDelta,40000,03/04/2026,04/05/2026\n';
  const apr = await makePdf([paystub('2026-04-05', '5,000.00', '11,000.00')]);
  await createPlan(page);
  await page.getByTestId('drop-files').setInputFiles([
    { name: 'deals.csv', mimeType: 'text/csv', buffer: Buffer.from(deals) },
    { name: 'paystub-apr.pdf', mimeType: 'application/pdf', buffer: apr },
  ]);
  const dlg = page.getByRole('dialog', { name: 'Here’s what we found' });
  await expect(dlg.getByTestId('drop-confirm')).toBeDisabled();
  await dlg.getByLabel('January 2 (month first, US style)').check();
  // Leave best guesses for us to review this time.
  await dlg.getByLabel(/make a best guess/).uncheck();
  await dlg.getByTestId('drop-confirm').click();
  await expect(page.getByText('Added 2 deals and 1 payment. 1 payment still needs matching.')).toBeVisible();
  await page.getByRole('button', { name: 'Review matches' }).click();
  const review = page.getByRole('dialog', { name: 'Match payments to deals' });
  await expect(review.getByTestId('match-summary')).toHaveText('1 best guess');
  await review.getByRole('button', { name: 'Match 1 payment' }).click();
  await expect(page.getByText('Not final yet')).toHaveCount(0);
});

test('start screen fits small phones', async ({ page }) => {
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    if (width === 320) await createPlan(page);
    await expect(page.getByRole('heading', { name: 'Add your deals and paystubs' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test('the logo goes home from setup and from the example', async ({ page }) => {
  const landing = page.getByRole('heading', { name: /You closed the deal\.\s*Did you get paid for it\?/ });
  await page.goto('/');
  await page.getByRole('button', { name: 'Prefer typing? Enter deals by hand' }).click();
  await expect(page.getByRole('heading', { name: 'Three quick questions about your plan' })).toBeVisible();
  await page.getByRole('link', { name: 'Check My Check home' }).click();
  await expect(landing).toBeVisible();

  await page.getByRole('button', { name: 'Try an example →' }).click();
  await expect(page.getByText('Example workspace.')).toBeVisible();
  await page.getByRole('link', { name: 'Check My Check home' }).click();
  await expect(page.getByText('Example workspace.')).toHaveCount(0);
  await expect(landing).toBeVisible();

  // With data, home is the summary.
  await createPlan(page);
  await addDeal(page, 'Acme', '1000', '2026-01-10', '2026-02-15');
  await openSettings(page, 'Commission plan');
  await page.getByRole('link', { name: 'Check My Check home' }).click();
  await expect(page.getByTestId('deal-row-Acme')).toBeVisible();
});
