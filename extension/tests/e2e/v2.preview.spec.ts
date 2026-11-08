import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
const profile = JSON.parse(readFileSync(new URL('../../../contracts/v2/public-profile.fixture.json', import.meta.url), 'utf8'));

test('v2 question sends choice id, permits retry, and offers explicit resume', async ({ page }) => {
  await page.goto('/tests/showcase/v2.html');
  await expect(page.getByRole('heading', { name: 'Reading a 2D list' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Check answer' })).toBeDisabled();
  await page.getByRole('radio', { name: '1', exact: true }).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByRole('button', { name: 'Skip and watch' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume video' })).toHaveCount(0);
  await page.getByRole('radio', { name: '3', exact: true }).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByRole('heading', { name: 'Well done' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume video' }).click();
  await expect(page.getByLabel('Last action')).toHaveText('resume');
});

for (const state of ['short', 'predict']) test(`v2 ${state} answer isolates YouTube hotkeys`, async ({ page }) => {
  await page.goto(`/tests/showcase/v2.html?state=${state}`);
  const answer = page.getByRole('textbox');
  for (const key of ['Space', 'j', 'k', 'l', 'f']) await answer.press(key);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { pageHotkeys: number }).pageHotkeys)).toBe(0);
  await answer.fill('3'); await answer.press('Tab');
  await expect(page.getByRole('button', { name: 'Skip and watch' })).toBeFocused();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByRole('heading', { name: 'Well done' })).toBeVisible();
});

test('v2 diagnoses decorate exact submitted lines and beginner optimization stays hidden', async ({ page }) => {
  await page.goto('/tests/showcase/v2.html?state=failed');
  await expect(page.locator('.bp-v2-diagnosed-line')).toHaveCount(2);
  await expect(page.locator('[data-diagnosis-line="3"]')).toContainText('while pow_num > 0');
  await expect(page.locator('[data-diagnosis-line="4"]')).toContainText('result *= base_num');
  await page.goto('/tests/showcase/v2.html?state=beginner-passed');
  await expect(page.getByText('Improve your solution')).toHaveCount(0);
  await page.goto('/tests/showcase/v2.html?state=passed');
  await page.getByText('Improve your solution').click();
  await expect(page.getByText('Your solution:', { exact: false })).toBeVisible();
});

test('v2 controls and refresher callbacks work', async ({ page }) => {
  await page.goto('/tests/showcase/v2.html?state=settings');
  await page.getByLabel('Pause frequency').selectOption('few');
  await page.getByLabel('Automatically pause for practice').uncheck();
  await page.getByLabel('Never pause on this video').check();
  await expect(page.getByLabel('Never pause on this video')).toBeChecked();
  await page.goto('/tests/showcase/v2.html?state=refresher');
  await page.getByRole('button', { name: 'Start refresher' }).click();
  await expect(page.getByRole('status')).toHaveText('lists');
  await page.goto('/tests/showcase/v2.html?state=unavailable');
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Dismissed', { exact: true })).toBeVisible();
});

test('v2 request errors remain actionable and deliberate success holds have no countdown', async ({ page }) => {
  await page.goto('/tests/showcase/v2.html?state=question-error');
  await expect(page.getByRole('alert')).toContainText('Connection failed.');
  await expect(page.getByRole('button', { name: 'Skip and watch' })).toBeEnabled();
  await page.goto('/tests/showcase/v2.html?state=question-resume-error');
  await expect(page.getByText('The browser didn’t resume playback.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Resume video' }).click();
  await expect(page.getByLabel('Last action')).toHaveText('resume');
  await page.goto('/tests/showcase/v2.html?state=coding-passed');
  await expect(page.getByRole('button', { name: 'Resume video' })).toBeVisible();
  await expect(page.locator('.bp-countdown')).toHaveCount(0);
  await expect(page.getByText('The browser didn’t resume playback.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Practice feedback' })).toBeVisible();
});

test('v2 profile switches accounts, preserves settings and recovers an API failure', async ({ page }) => {
  let unavailable = true;
  await page.route('http://127.0.0.1:8000/v2/**', async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ status: unavailable ? 501 : 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(path.endsWith('/accounts') ? [
      { accountId: 'test-ana', displayName: 'Ana (test)' }, { accountId: 'test-ben', displayName: 'Ben (test)' },
    ] : { ...profile, ...(path.endsWith('test-ben') ? { accountId: 'test-ben', displayName: 'Ben (test)' } : {}) }) });
  });
  await page.goto('/tests/showcase/v2.html?state=profile-live');
  await expect(page.getByRole('alert')).toContainText('not available yet');
  unavailable = false; await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Ana (test)' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Loops level progress' })).toHaveAttribute('value', '0.5625');
  await page.getByLabel('Test account').selectOption('test-ben');
  await expect(page.getByRole('heading', { name: 'Ben (test)', level: 1 })).toBeVisible();
  await page.getByLabel('Pause frequency').selectOption('many');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ben (test)', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Pause frequency')).toHaveValue('many');
});

for (const theme of ['dark', 'light']) test(`v2 ${theme} showcase captures every new view`, async ({ page }, info) => {
  for (const state of ['question', 'short', 'predict', 'question-checking', 'question-passed', 'question-error', 'question-resume-error', 'failed', 'passed', 'beginner-passed', 'profile', 'refresher', 'settings', 'unavailable', 'level-up', 'coding-level', 'coding-passed']) {
    await page.goto(`/tests/showcase/v2.html?state=${state}&theme=${theme}`);
    await expect(page.locator('.bp-v2').first()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${state}-${theme}.png`), fullPage: true, animations: 'disabled' });
    expect(await page.locator('.breakpoint-shell').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
});

for (const theme of ['dark', 'light']) test(`v2 ${theme} text contrast meets 4.5 to 1`, async ({ page }) => {
  await page.goto(`/tests/showcase/v2.html?state=profile&theme=${theme}`);
  const ratios = await page.locator('.bp-v2-card').first().evaluate(card => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (color: number[]) => color.map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const bg = luminance(rgb(getComputedStyle(card).backgroundColor));
    return ['h2', 'small'].map(selector => {
      const fg = luminance(rgb(getComputedStyle(card.querySelector(selector)!).color));
      return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
    });
  });
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
});
