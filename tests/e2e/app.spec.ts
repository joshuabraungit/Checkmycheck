import { expect, test, type Page } from '@playwright/test';

async function createPlan(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Did your commission check add up?' })).toBeVisible();
  await page.getByRole('button', { name: 'Start my tracker' }).click();
  await page.getByLabel('Calendar year').fill('2026');
  await page.getByLabel('Annual quota (credited revenue, $)').fill('100000');
  await page.getByLabel('Base commission rate (%)').fill('10');
  await page.getByLabel('Accelerator rate (%)').fill('15');
  // Unsupported features are listed before confirming.
  await expect(page.getByText('Retroactive accelerators')).toBeVisible();
  await page.getByLabel('My plan uses the credited revenue entered here and a marginal accelerator above an annual quota.').check();
  await page.getByRole('button', { name: 'Save plan and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Deals in 2026' })).toBeVisible();
}

async function addDeal(page: Page, account: string, revenue: string, close: string, expected: string) {
  await page.getByRole('button', { name: 'Add deal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a deal' });
  await dialog.getByLabel('Account name').fill(account);
  await dialog.getByLabel('Credited revenue ($)').fill(revenue);
  await dialog.getByLabel('Close date').fill(close);
  await dialog.getByLabel('Expected payment date').fill(expected);
  await dialog.getByRole('button', { name: 'Add deal' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId(`deal-row-${account}`)).toBeVisible();
}

async function setAsOf(page: Page, date: string) {
  const input = page.getByLabel('As of');
  if (!(await input.isVisible())) await page.getByRole('button', { name: 'Change date' }).click();
  await input.fill(date);
}

async function openSettings(page: Page, item: 'Commission plan' | 'Backup & files') {
  await page.getByRole('button', { name: 'Settings' }).click();
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
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
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
  await page.getByRole('button', { name: 'Overview' }).click();
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
  await page.getByRole('button', { name: 'Draft a payroll question' }).click();
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
  await page.getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Acme, view calculation' }).click();
  await page.getByRole('dialog', { name: 'Acme' }).getByRole('button', { name: 'Delete deal' }).click();
  const confirmDelete = page.getByRole('dialog', { name: 'Delete Acme?' });
  await expect(confirmDelete).toContainText('$6,000.00 allocated to it returns to the unallocated balance of 1 payment');
  await expect(confirmDelete.getByTestId('deal-impact')).toContainText('2 other deals');
  await confirmDelete.getByRole('button', { name: 'Delete deal' }).click();
  await expect(page.getByTestId('deal-row-Acme')).toHaveCount(0);
  await expect(page.getByText('Match your payments to deals to finish the comparison.')).toBeVisible();
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
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
  await page.getByRole('button', { name: 'Overview' }).click();
  await setAsOf(page, '2026-06-30');
  await expect(page.getByTestId('deal-row-Acme')).toBeVisible();
  await expect(page.getByTestId('received-due')).toHaveText('$9,000.00');
  await expect(page.getByTestId('difference')).toHaveText('$2,500.00');
});

test('demo mode shows exact totals and never overwrites personal records', async ({ page }) => {
  await createPlan(page);
  await setAsOf(page, '2026-06-30');
  await addDeal(page, 'My Real Deal', '12345.67', '2026-03-03', '2026-04-15');

  await page.getByRole('button', { name: 'View example' }).click();
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
  await page.getByRole('button', { name: 'View example' }).click();
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

  await page.getByRole('button', { name: 'Overview' }).click();
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
    await page.getByRole('button', { name: 'Payments', exact: true }).click();
    await noScroll();
    for (const item of ['Commission plan', 'Backup & files'] as const) {
      await openSettings(page, item);
      await noScroll();
    }
    await page.getByRole('button', { name: 'Payments', exact: true }).click();
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
  await expect(other.getByRole('heading', { name: 'Deals in 2026' })).toBeVisible();
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
  await page.getByTestId('import-deals').setInputFiles(file);
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
  await expect(page.getByTestId('deal-row-Acme')).toBeVisible();
  await expect(page.getByTestId('expected-due')).toHaveText('$11,500.00');

  // Next month's export: same layout, one new deal. Choices are remembered and existing deals are skipped.
  const next = crm.replace('Total,,', 'Me,Cedar,"$20,000.00",03/20/2026,OPP-3\nTotal,,');
  await page.getByTestId('import-deals').setInputFiles({ ...file, buffer: Buffer.from(next) });
  await expect(dlg).toContainText('column choices from your last import');
  await expect(dlg.getByTestId('import-summary')).toContainText('1 deal ready · 3 skipped');
  await dlg.getByRole('button', { name: 'Import 1 deal' }).click();
  await expect(page.getByTestId('deal-row-Cedar')).toBeVisible();
  await expect(page.getByTestId('deal-row-Acme')).toHaveCount(1);
});

test('blocks the whole import when any row has a problem', async ({ page }) => {
  await createPlan(page);
  const csv = 'Customer,ACV,Close Date\nGood,100,2026-01-10\nBad,TBD,2026-01-11\n';
  await page.getByTestId('import-deals').setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
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
  await page.getByTestId('import-deals').setInputFiles({ name: 'deals.xlsx', mimeType: xlsxType, buffer: deals });
  const dlg = page.getByRole('dialog', { name: 'Import deals from a spreadsheet' });
  await expect(dlg.getByTestId('import-summary')).toContainText('2 deals ready');
  await expect(dlg).toContainText('$50,000.50');
  await expect(dlg).toContainText('Mar 15, 2026');
  await dlg.getByRole('button', { name: 'Import 2 deals' }).click();
  await expect(page.getByTestId('deal-row-Beacon')).toBeVisible();

  const statement = await writeExcelFile([
    [{ value: 'Q1 commission statement' }],
    [],
    [{ value: 'Pay Date' }, { value: 'Gross Commission' }, { value: 'Net Pay' }, { value: 'Statement' }],
    [{ value: new Date(Date.UTC(2026, 1, 15)), type: Date, format: 'mm/dd/yyyy' }, { value: 6000, type: Number }, { value: 4100, type: Number }, { value: 'Feb' }],
    [{ value: new Date(Date.UTC(2026, 2, 15)), type: Date, format: 'mm/dd/yyyy' }, { value: 7950, type: Number }, { value: 5400, type: Number }, { value: 'Mar' }],
  ]).toBuffer();
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
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
  await page.getByTestId('import-deals').setInputFiles(file);
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
  await expect(page.getByTestId('deal-row-Beacon')).toBeVisible();

  // Same file on the Payments tab lands on the paystub log.
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
  await page.getByTestId('import-payments').setInputFiles(file);
  const pdlg = page.getByRole('dialog', { name: 'Import payments from a spreadsheet' });
  await expect(pdlg.getByLabel('Which tab has your payments?').locator('option:checked')).toHaveText('Paystub Log');
  await expect(pdlg.getByTestId('import-summary')).toContainText('2 payments ready');
  await expect(pdlg).toContainText('Total: $11,500.00');
  await pdlg.getByRole('button', { name: 'Import 2 payments' }).click();
  await expect(page.getByTestId('payment-card')).toHaveCount(2);
});

async function importCsv(page: Page, kind: 'deals' | 'payments', csv: string, order?: 'MDY') {
  await page.getByTestId(`import-${kind}`).setInputFiles({ name: `${kind}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const dlg = page.getByRole('dialog', { name: `Import ${kind} from a spreadsheet` });
  if (order) await dlg.getByLabel(/month first/).check();
  await dlg.getByRole('button', { name: new RegExp(`^Import \\d+ ${kind.slice(0, -1)}`) }).click();
  await expect(dlg).toBeHidden();
}

test('auto-matches lump-sum payments to deals and finds the real shortfall', async ({ page }) => {
  await createPlan(page);
  await setAsOf(page, '2026-06-30');
  await importCsv(
    page,
    'deals',
    'Account,ARR,Close Date,Expected Payout Date\nAcme,60000,2026-01-20,2026-02-15\nBeacon,30000,2026-02-03,2026-03-15\nCedar,20000,2026-02-25,2026-03-15\nDelta,40000,2026-03-10,2026-04-15\n',
  );
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
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
  await page.getByRole('button', { name: 'Overview' }).click();
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
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
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
  await page.getByRole('button', { name: 'Overview' }).click();
  await page.getByTestId('import-deals').setInputFiles(pdf('report.pdf', report));
  const ddlg = page.getByRole('dialog', { name: 'Import deals from a spreadsheet' });
  await expect(ddlg.getByTestId('import-summary')).toContainText('2 deals ready');
  await ddlg.getByRole('button', { name: 'Import 2 deals' }).click();
  await expect(page.getByTestId('deal-row-Beacon')).toBeVisible();
});
