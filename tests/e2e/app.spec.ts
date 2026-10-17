import { expect, test, type Page } from '@playwright/test';

async function createPlan(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Did your commission check add up?' })).toBeVisible();
  await page.getByRole('button', { name: 'Start my tracker' }).click();
  await page.getByLabel('Calendar year').fill('2026');
  await page.getByLabel('Annual quota (credited revenue, $)').fill('100000');
  await page.getByLabel('Base commission rate (%)').fill('10');
  await page.getByLabel('Tier 2 starts at (% of quota)').fill('100');
  await page.getByLabel('Tier 2 rate (%)').fill('15');
  // Unsupported features are listed before confirming.
  await expect(page.getByText('Commission caps')).toBeVisible();
  await page.getByLabel('My plan uses the credited revenue entered here, with the quota and rates above.').check();
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
  await page.locator('#deal-csv').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(bad) });
  const dlg = page.getByRole('dialog', { name: /Import deals/ });
  await expect(dlg).toContainText('Nothing was imported');
  await expect(dlg).toContainText('Row 3');
  await dlg.getByRole('button', { name: 'Close' }).first().click();

  const good = 'deal_id,plan_year,account,reference,credited_revenue_usd,close_date,expected_payment_date,same_day_order,notes\n,2026,"Acme, Inc.",R1,"60,000.00",2026-01-10,2026-02-15,,"multi\nline"\n,2026,Acme,R2,500,2026-01-10,2026-02-15,,\n';
  await page.locator('#deal-csv').setInputFiles({ name: 'good.csv', mimeType: 'text/csv', buffer: Buffer.from(good) });
  await expect(dlg).toContainText('2 deals ready to import');
  await dlg.getByRole('button', { name: 'Import 2 deals' }).click();
  await expect(page.getByText('Imported 2 deals.')).toBeVisible();

  const pays = 'payment_id,payment_date,gross_commission_usd,reference,notes\n,2026-02-15,6000,Feb,\n';
  await page.locator('#payment-csv').setInputFiles({ name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from(pays) });
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
  await dlg.getByLabel('Tier 2 rate (%)').fill('20');
  await dlg.getByRole('button', { name: 'Review changes' }).click();
  await expect(dlg).toContainText('$11,500.00');
  await expect(dlg).toContainText('$12,000.00');
  await expect(dlg).toContainText('1 of 2');
  await expect(dlg).toContainText('does not model midyear plan changes');
  await dlg.getByRole('button', { name: 'Save plan changes' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByText('10%, 20% from 100% of quota (marginal)')).toBeVisible();
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

test('quarterly retroactive plan: the crossing deal carries the catch-up and quarters reset', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start my tracker' }).click();
  await page.getByLabel('Calendar year').fill('2026');
  await page.getByLabel('Each quarter (attainment starts over every quarter)').check();
  for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) await page.getByLabel(`${q} quota ($)`).fill('50000');
  await page.getByLabel('Base commission rate (%)').fill('10');
  await page.getByLabel('Tier 2 rate (%)').fill('15');
  await page.getByLabel(/All revenue so far in the quarter \(retroactive\)/).check();
  await page.getByLabel('My plan uses the credited revenue entered here, with the quota and rates above.').check();
  await page.getByRole('button', { name: 'Save plan and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Deals in 2026' })).toBeVisible();

  await addDeal(page, 'Early', '40000', '2026-01-10', '2026-02-15');
  await addDeal(page, 'Crosser', '20000', '2026-02-10', '2026-03-15');
  await addDeal(page, 'Next Quarter', '30000', '2026-04-10', '2026-05-15');

  // 20k at 15% plus the catch-up of 40k x (15% - 10%).
  await expect(page.getByTestId('deal-row-Crosser')).toContainText('$5,000.00');
  // Q2 starts over at the base rate.
  await expect(page.getByTestId('deal-row-Next Quarter')).toContainText('$3,000.00');

  await page.getByRole('button', { name: 'Crosser, view calculation' }).click();
  const detail = page.getByRole('dialog', { name: 'Crosser' });
  await expect(detail).toContainText('Credited revenue in Q1 2026 before this deal');
  await expect(detail.getByTestId('true-up')).toContainText('$40,000.00 × (15% − 10%)');
  await expect(detail.getByTestId('true-up')).toContainText('$2,000.00');
  await page.keyboard.press('Escape');

  await openSettings(page, 'Commission plan');
  await expect(page.getByText('10%, 15% from 100% of quota (retroactive)')).toBeVisible();
});
