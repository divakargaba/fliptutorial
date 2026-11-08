import { expect, test } from '@playwright/test';
import { auditPanel } from './panel-audit';

test('Test me is opt-in and disabled without a ready player', async ({ page }) => {
  await page.goto('/tests/e2e/preview.html?testme=off');
  await expect(page.getByRole('button', { name: 'Test me', exact: true })).toHaveCount(0);
  await page.goto('/tests/e2e/preview.html?testme=on&unready');
  await expect(page.getByRole('button', { name: 'Test me', exact: true })).toBeDisabled();
});

test('generation can close while loading and labels survive results and Solved', async ({ page }, info) => {
  await page.goto('/tests/e2e/preview.html?testme=on');
  const start = page.getByRole('button', { name: 'Test me', exact: true });
  await start.click();
  await expect(page.getByRole('heading', { name: 'Creating your practice…' })).toBeFocused();
  await expect(start).toBeDisabled();
  await expect(page.getByText('AI-generated practice', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('test-me-loading.png') });
  await page.getByRole('button', { name: 'Resume video', exact: true }).click();
  await expect(start).toBeFocused();
  await expect(page.locator('.bp-panel')).toHaveCount(0);
  await start.click();
  await expect(page.getByRole('textbox', { name: 'Python code' })).toBeVisible();
  await expect(page.getByText('AI-generated practice', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Examples passed', { exact: true })).toBeVisible();
  await expect(page.getByText('AI-generated practice', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Solved', exact: true })).toBeFocused();
  await expect(page.getByText('AI-generated practice', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('test-me-solved.png') });
});

for (const code of ['NO_CAPTIONS', 'NOT_PYTHON', 'TOO_EARLY', 'GENERATOR_UNAVAILABLE', 'GENERATOR_TIMEOUT', 'BUSY', 'NETWORK', 'TIMEOUT']) {
  test(`generation handles ${code} with a reachable exit`, async ({ page }, info) => {
    await page.goto(`/tests/e2e/preview.html?testme=on&error=${code}`);
    await page.getByRole('button', { name: 'Test me', exact: true }).click();
    await expect(page.getByText(`Fixture ${code}.`, { exact: true })).toBeVisible();
    await expect(page.getByText('AI-generated practice', { exact: true })).toBeVisible();
    const retry = page.getByRole('button', { name: 'Try again', exact: true });
    if (['NO_CAPTIONS', 'NOT_PYTHON', 'TOO_EARLY'].includes(code)) await expect(retry).toHaveCount(0);
    else {
      await retry.click();
      await expect(page.getByRole('heading', { name: 'Creating your practice…' })).toBeFocused();
      await expect(page.getByText(`Fixture ${code}.`, { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath(`test-me-${code}.png`) });
    await page.getByRole('button', { name: 'Close generated practice' }).click();
    await expect(page.getByRole('button', { name: 'Test me', exact: true })).toBeFocused();
    await expect(page.locator('.bp-panel')).toHaveCount(0);
  });
}

for (const theme of ['dark', 'light']) {
  test(`expired set preserves the draft and disables grading in ${theme}`, async ({ page }, info) => {
    await page.goto(`/tests/e2e/preview.html?testme=on&expired&theme=${theme}`);
    await page.getByRole('button', { name: 'Test me', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Python code' });
    await editor.fill('# keep this generated draft');
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Practice expired', { exact: true })).toBeVisible();
    await expect(editor).toHaveText('# keep this generated draft');
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
    await editor.press('Control+Enter');
    await expect(page.getByText('Practice expired', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`test-me-expired-${theme}.png`) });
    const audit = await auditPanel(page);
    expect(audit.contrastFailures).toEqual([]);
    expect(audit.controlFailures).toEqual([]);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Practice later', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Test me', exact: true }).click();
    await expect(editor).toHaveText('# keep this generated draft');
  });
}
