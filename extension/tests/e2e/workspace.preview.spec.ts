import { expect, test } from '@playwright/test';

test('popup keeps settings reachable at 400 × 600 and colors demand categories', async ({ page }, info) => {
  await page.setViewportSize({ width: 400, height: 600 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/showcase/v2.html?state=profile-demo');
  const fields = page.locator('.bp-pf-field');
  await expect(fields).toHaveCount(3);
  await expect(fields.nth(0)).toHaveAttribute('data-tone', 'teal');
  await expect(fields.nth(1)).toHaveAttribute('data-tone', 'blue');
  await expect(fields.nth(2)).toHaveAttribute('data-tone', 'violet');
  await page.locator('#demand-head').evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 110));
  await page.screenshot({ path: info.outputPath('popup-demand.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const below = page.getByRole('button', { name: 'Below video', exact: true });
  const side = page.getByRole('button', { name: 'Side panel', exact: true });
  await expect(below).toBeInViewport({ ratio: 1 });
  const group = await page.getByRole('group', { name: 'Practice placement' }).boundingBox();
  const button = await below.boundingBox();
  expect(button!.width).toBeGreaterThan(group!.width * .45);
  await side.click();
  await expect(side).toHaveAttribute('aria-pressed', 'true');
  await expect(side).toBeFocused();
  await page.screenshot({ path: info.outputPath('popup-settings.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(side).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('workspace remains usable at 320px with long code and light theme', async ({ page }, info) => {
  await page.setViewportSize({ width: 352, height: 600 });
  await page.goto('/tests/e2e/preview.html?workspace&theme=light');
  await page.getByRole('button', { name: 'Side', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Python code' });
  await editor.fill('def raise_to_power(base, exponent):\n    return base ** exponent # ' + 'long code '.repeat(20));
  await page.getByRole('button', { name: 'Stuck? Get a hint', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to code' })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('workspace-320-light-hint.png') });
});
