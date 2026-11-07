import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/tests/e2e/preview.html'); });

test('shadow theme, keyboard isolation, grading and resume controls', async ({ page }, info) => {
  const editor = page.getByRole('textbox', { name: 'Python code' });
  await expect(editor).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Raise a number to a power' })).toBeFocused();
  const panel = page.locator('.bp-panel');
  expect(await panel.evaluate(el => getComputedStyle(el).fontSize)).toBe('14px');
  expect(await page.locator('.bp-body').evaluate(el => getComputedStyle(el).paddingLeft)).toBe('16px');
  expect(await panel.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('1px');
  await page.screenshot({ path: info.outputPath('editing.png') });
  await editor.fill('jklf ');
  await editor.press('Space');
  for (const key of ['j', 'k', 'l', 'f']) await editor.press(key);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { pageHotkeys: number }).pageHotkeys)).toBe(0);
  await editor.press('Tab');
  await expect(page.getByRole('button', { name: 'Skip and watch' })).toBeFocused();
  await editor.fill('def raise_to_power(base, exponent):\n    return base * exponent');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('wrong answer', { exact: false })).toBeVisible();
  await expect(page.locator('.bp-case-detail')).toContainText('Expected8');
  await expect(page.locator('.bp-case-detail')).toContainText('Output6');
  await page.locator('.bp-results').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('failed.png') });
  await editor.fill('def raise_to_power(base, exponent):\n    return base ** exponent');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Examples passed', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume video' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Solved' })).toBeVisible();
  const resume = await page.getByRole('button', { name: 'Resume video' }).boundingBox();
  expect(resume!.y + resume!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.waitForTimeout(900); // let the solved animation settle for the screenshot
  await page.screenshot({ path: info.outputPath('passed.png') });
  await page.getByRole('button', { name: 'Resume video' }).click();
  await expect(panel).toHaveCount(0);
});

test('flushes on close, reloads drafts and isolates revisions', async ({ page }) => {
  const editor = page.getByRole('textbox', { name: 'Python code' });
  await editor.fill('# my draft');
  await page.getByRole('button', { name: 'Close practice' }).click();
  await expect(page.getByRole('button', { name: /^Breakpoint · 1 challenge/ })).toBeFocused();
  await page.getByRole('button', { name: /^Breakpoint · 1 challenge/ }).click();
  await expect(editor).toContainText('# my draft');
  await page.reload();
  await expect(editor).toContainText('# my draft');
  await page.goto('/tests/e2e/preview.html?revision=next');
  await expect(editor).toContainText('def raise_to_power');
  await expect(editor).not.toContainText('# my draft');
});

test('skip is reachable during grading and after provider failure', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Python code' }).fill('provider_error');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Skip and watch' })).toBeEnabled();
  await expect(page.getByText('Grading timed out.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.getByRole('button', { name: 'Skip and watch' }).click();
  await expect(page.locator('.bp-panel')).toHaveCount(0);
});
