import { expect, test } from '@playwright/test';
import { unlockHints } from './extension.fixture';
import { readFileSync } from 'node:fs';
const profile = JSON.parse(readFileSync(new URL('../../../contracts/v2/public-profile.fixture.json', import.meta.url), 'utf8'));

test('popup keeps settings reachable at 400 × 600 and demand surfaces neutral', async ({ page }, info) => {
  await page.setViewportSize({ width: 400, height: 600 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/showcase/v2.html?state=profile-demo');
  await expect(page.getByRole('tab', { name: 'Home', exact: true })).toHaveAttribute('aria-selected', 'true');
  const fields = page.locator('.bp-pf-field');
  await expect(fields).toHaveCount(3);
  const demand = await page.locator('#demand-head').boundingBox();
  const recent = await page.getByText('Recent practice', { exact: true }).boundingBox();
  expect(demand!.y).toBeLessThan(recent!.y);
  await page.screenshot({ path: info.outputPath('home-discovery.png'), animations: 'disabled' });
  await page.getByRole('tab', { name: 'Skills', exact: true }).click();
  await expect(fields).toHaveCount(0);
  await page.getByRole('tab', { name: 'Home', exact: true }).click();
  await expect(fields).toHaveCount(3);
  for (const field of await fields.all()) {
    await expect(field.locator('.bp-pf-field-icon')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  await page.locator('#demand-head').evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 110));
  await page.screenshot({ path: info.outputPath('popup-demand.png'), animations: 'disabled' });
  await fields.first().locator('summary').click();
  const tutorial = fields.first().locator('.bp-pf-field-link');
  await expect(tutorial).toHaveCSS('background-color', 'rgb(13, 13, 15)');
  await expect(tutorial).toHaveCSS('color', 'rgb(237, 237, 240)');
  await tutorial.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('popup-demand-expanded.png'), animations: 'disabled' });
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

test('black skill rows separate Solved and XP in own and teammate profiles', async ({ page }, info) => {
  await page.setViewportSize({ width: 400, height: 600 });
  await page.route('http://127.0.0.1:8000/v2/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/accounts') ? [
      { accountId: 'test-ana', displayName: 'Ana (test)' }, { accountId: 'test-ben', displayName: 'Ben (test)' },
    ] : path.includes('test-ben') ? { ...profile, accountId: 'test-ben', displayName: 'Ben (test)' } : profile;
    await route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto('/tests/showcase/v2.html?state=profile-live');
  await page.getByRole('tab', { name: 'Skills', exact: true }).click();
  const checkRows = async (name: string) => {
    const rows = page.locator('.bp-learning-skill-stats');
    await expect(rows).toHaveCount(3);
    for (const row of await rows.all()) {
      const boxes = await row.locator(':scope > div').evaluateAll(els => els.map(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })));
      expect(boxes[1].left - boxes[0].right).toBeGreaterThanOrEqual(19);
      await expect(row.locator('dt')).toHaveText(['Solved', 'XP']);
    }
    await expect(page.locator('.bp-pf-group').filter({ has: rows.first() })).toHaveCSS('background-color', 'rgb(17, 17, 19)');
    await rows.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await checkRows('own-black-skills');
  await page.getByRole('tab', { name: /Network/ }).click();
  await page.getByRole('button', { name: /Ben/ }).click();
  await checkRows('teammate-black-skills');
  await page.setViewportSize({ width: 320, height: 600 });
  await checkRows('teammate-black-skills-narrow');
});

test('workspace remains usable at 320px with long code and light theme', async ({ page }, info) => {
  await page.setViewportSize({ width: 352, height: 600 });
  await page.goto('/tests/e2e/preview.html?workspace&theme=light');
  await page.getByRole('button', { name: 'Side', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Python code' });
  await unlockHints(page);
  await editor.fill('def raise_to_power(base, exponent):\n    return base ** exponent # ' + 'long code '.repeat(20));
  await page.getByRole('button', { name: 'Stuck? Get a hint', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to code' })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('workspace-320-light-hint.png') });
  await page.getByRole('button', { name: 'Back to code', exact: true }).click();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.locator('.bp-more-options')).toBeInViewport({ ratio: 1 });
  expect(await page.locator('.bp-more-options').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});
