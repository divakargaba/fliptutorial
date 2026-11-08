import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
const profile = JSON.parse(readFileSync(new URL('../../../contracts/v2/public-profile.fixture.json', import.meta.url), 'utf8'));

test('v2 account switching isolates drafts, including unflushed edits', async ({ page }) => {
  await page.goto('/tests/showcase/v2.html?state=coding-accounts');
  const editor = page.getByRole('textbox', { name: 'JavaScript code' });
  await editor.fill('// Ana private draft');
  await page.getByLabel('Draft account').selectOption('test-ben');
  await expect(editor).toContainText('function solution');
  await editor.fill('// Ben private draft');
  await page.getByLabel('Draft account').selectOption('test-ana');
  await expect(editor).toHaveText('// Ana private draft');
  await page.getByLabel('Draft account').selectOption('test-ben');
  await expect(editor).toHaveText('// Ben private draft');
  await page.reload();
  await expect(editor).toHaveText('// Ana private draft');
});

for (const [language, label, filename] of [['javascript', 'JavaScript', 'main.js'], ['java', 'Java', 'Main.java'], ['cpp', 'C++', 'main.cpp'], ['sql', 'SQL', 'query.sql']]) {
  test(`v2 ${language} editor presents its language and submits exact source`, async ({ page }, info) => {
    await page.goto(`/tests/showcase/v2.html?state=coding-language&language=${language}`);
    await expect(page.locator('.bp-file')).toHaveText(filename!);
    await expect(page.locator('.bp-call')).toHaveText('Input: true, null');
    await expect(page.locator('.bp-expected')).toHaveText('false');
    const editor = page.getByRole('textbox', { name: `${label} code`, exact: true });
    await editor.fill('source with jklf and spaces');
    await editor.press('Control+Enter');
    await expect(page.getByLabel('Submitted source')).toHaveText('source with jklf and spaces');
    await editor.press('Tab');
    await expect(editor).not.toBeFocused();
    for (const theme of ['dark', 'light']) {
      await page.locator('.breakpoint-shell').evaluate((shell, theme) => { (shell as HTMLElement).dataset.theme = theme; }, theme);
      await page.screenshot({ path: info.outputPath(`${language}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
  });
}

test('v2 question sends choice id, permits retry, and offers explicit resume', async ({ page }) => {
  await page.goto('/tests/showcase/v2.html');
  await expect(page.getByRole('heading', { name: 'Reading a 2D list' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Check answer' })).toBeDisabled();
  await page.getByRole('radio', { name: '1', exact: true }).check();
  await page.getByRole('button', { name: 'Check answer' }).click();
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeEnabled();
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
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused();
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
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeEnabled();
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

test('v2 Practice later stays under More and supports keyboard dismissal', async ({ page }) => {
  await page.goto('/tests/showcase/v2.html?state=question');
  await expect(page.getByRole('button', { name: 'Practice later', exact: true })).toHaveCount(0);
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.click();
  await page.getByRole('button', { name: 'Practice later', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Last action')).toHaveText('skip');
});

for (const theme of ['dark', 'light']) test(`v2 ${theme} timeline clusters ready challenges and preserves passed state`, async ({ page }, info) => {
  await page.goto(`/tests/showcase/v2.html?state=timeline&theme=${theme}`);
  const markers = page.getByRole('group', { name: 'Challenge timeline', exact: true }).getByRole('button');
  await expect(markers).toHaveCount(2);
  await expect(markers.last()).toHaveAttribute('data-passed', 'true');
  await markers.first().focus();
  await page.keyboard.press('Enter');
  const nearby = page.getByRole('group', { name: 'Nearby challenges', exact: true });
  await expect(nearby).toBeVisible();
  await nearby.getByRole('button').first().click();
  await expect(page.getByLabel('Opened challenge')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Close nearby challenges' }).click();
  await page.getByText('Challenges (4)', { exact: true }).click();
  await expect(page.locator('.bp-challenge-list li')).toHaveCount(4);
  await expect(page.locator('.bp-challenge-list small').filter({ hasText: 'Passed · Review' })).toHaveCount(1);
  await expect(page.locator('.bp-challenge-list small').filter({ hasText: 'Unfinished · Practice' })).toHaveCount(3);
  await markers.last().click();
  await expect(page.getByLabel('Opened challenge')).toHaveText('later');
  await expect(markers.last()).toHaveAttribute('data-passed', 'true');
  expect(await page.locator('.breakpoint-shell').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`timeline-${theme}.png`), fullPage: true, animations: 'disabled' });
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
