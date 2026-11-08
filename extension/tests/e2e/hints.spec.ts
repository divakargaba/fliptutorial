import { expect } from '@playwright/test';
import { analysisFixture, automaticPause, correctCode, expectPlaying, hintFixture, test } from './extension.fixture';

for (const zoom of [1, 1.5]) test(`editor survives three long hints and failure at short height, zoom ${zoom}`, async ({ app }, info) => {
  const { page } = app;
  await page.setViewportSize({ width: info.project.name.endsWith('narrow') ? 1024 : 1440, height: 600 });
  const extensionId = new URL(page.context().serviceWorkers()[0]!.url()).host;
  const popup = await page.context().newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const actualZoom = await popup.evaluate(async zoom => {
    const current = await chrome.tabs.getCurrent();
    const tab = (await chrome.tabs.query({})).find(tab => tab.id !== current?.id)!;
    await chrome.tabs.setZoom(tab.id!, zoom);
    return chrome.tabs.getZoom(tab.id!);
  }, zoom);
  await popup.close();
  expect(actualZoom).toBe(zoom);
  await automaticPause(page);
  app.hintText = 'Track how the accumulator changes at each step before the next repetition. '.repeat(60);
  for (let level = 1; level <= 3; level++) {
    await page.getByRole('button', { name: level === 1 ? 'Stuck? Get a hint' : `Next hint (${level} of 3)`, exact: true }).click();
    await expect(page.locator('.bp-hint-card')).toHaveCount(level);
  }
  const toggles = page.locator('.bp-hint-toggle');
  await expect(toggles.nth(0)).toHaveAttribute('aria-expanded', 'false');
  await expect(toggles.nth(1)).toHaveAttribute('aria-expanded', 'false');
  await expect(toggles.nth(2)).toHaveAttribute('aria-expanded', 'true');
  // Older hints stay available to keyboard users, with the full text intact.
  await toggles.first().focus();
  await page.keyboard.press('Enter');
  await expect(toggles.first()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.bp-hint-content').first()).toContainText(app.hintText);
  const editor = page.getByRole('textbox', { name: 'Python code' });
  const code = 'def raise_to_power(base, exponent):\n    return base * exponent';
  await editor.fill(code);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Wrong answer', { exact: true })).toBeVisible();
  await expect(page.getByText('What went wrong', { exact: true })).toBeVisible();
  const card = page.locator('.bp-editor-card');
  expect(await card.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(210);
  expect(await page.locator('.bp-body').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await editor.scrollIntoViewIfNeeded();
  await editor.press('End');
  await editor.pressSequentially(' # still editable');
  await expect(editor).toContainText('still editable');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath(`editor-hints-zoom-${zoom}.png`), fullPage: true, animations: 'disabled' });
  expect(app.requests[0]?.code).toBe(code);
  expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
});

test('a long hint remains valid input for Next hint', async ({ app }) => {
  await automaticPause(app.page);
  app.hintText = 'Think about each step and the changing accumulator. '.repeat(85);
  await app.page.getByRole('button', { name: 'Stuck? Get a hint', exact: true }).click();
  await expect(app.page.locator('.bp-hint-card')).toHaveCount(1);
  await app.page.getByRole('button', { name: 'Next hint (2 of 3)', exact: true }).click();
  await expect(app.page.locator('.bp-hint-card')).toHaveCount(2);
  expect(app.hints[1]?.previousHints).toEqual([Array.from(`Hint 1: ${app.hintText}`).slice(0, 400).join('')]);
  await expect(app.page.locator('.bp-hint-card').first().locator('p')).toHaveText(`Hint 1: ${app.hintText}`);
  await expect(app.page.locator('.bp-hints .bp-inline-error')).toHaveCount(0);
  expect(await app.page.locator('video').evaluate(video => video.paused)).toBe(true);
});

test('wrong Run explains the failure and hints stop at three', async ({ app }, info) => {
  const { page } = app;
  await automaticPause(page);
  const code = 'def raise_to_power(base, exponent):\n    return base * exponent';
  await page.getByRole('textbox', { name: 'Python code' }).fill(code);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('What went wrong', { exact: true })).toBeVisible();
  await expect(page.locator('.bp-coach')).toContainText(hintFixture.feedback!);
  expect(app.hints[0]).toEqual({ exerciseId: 'samplevid01-exponent', revision: 'demo-1', code, level: 0,
    lastResult: { outcome: 'wrong_answer', args: [2, 3], expected: 8, actual: 6, diagnostic: null } });
  await page.locator('.bp-coach').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('failed-feedback.png'), animations: 'disabled' });
  for (let level = 1; level <= 3; level++) {
    await page.getByRole('button', { name: level === 1 ? 'Stuck? Get a hint' : `Next hint (${level} of 3)`, exact: true }).click();
    await expect(page.locator('.bp-hint-card')).toHaveCount(level);
    expect(app.hints[level]).toMatchObject({ exerciseId: 'samplevid01-exponent', revision: 'demo-1', code, level,
      previousHints: Array.from({ length: level - 1 }, (_, i) => `Hint ${i + 1}: ${hintFixture.hint}`) });
  }
  await expect(page.getByText("That's every hint.", { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Get a hint|Next hint/ })).toHaveCount(0);
  const sources = page.locator('.bp-hint-sources a');
  await expect(sources).toHaveCount(3);
  await expect(sources.first()).toHaveAttribute('href', hintFixture.sources[0]!.url);
  expect(app.hints.map(h => h.level)).toEqual([0, 1, 2, 3]);
  expect(app.analyses).toHaveLength(0);
  expect(await page.locator('video').evaluate(v => v.paused)).toBe(true);
  await page.locator('.bp-hints').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('hints-three.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Practice later', exact: true }).click();
  await expectPlaying(page);
});

test('inefficient Submit waits for review, stays paused and reveals a faster solution', async ({ app }, info) => {
  const { page } = app;
  app.analysis = analysisFixture;
  app.holdAnalysis = true;
  await automaticPause(page);
  await page.getByRole('textbox', { name: 'Python code' }).fill(correctCode);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Checking how efficient your solution is…')).toBeVisible();
  await expect.poll(() => app.analyses.length).toBe(1);
  expect(app.analyses[0]).toEqual({ exerciseId: 'samplevid01-exponent', revision: 'demo-1', code: correctCode });
  await page.screenshot({ path: info.outputPath('solved-checking.png'), animations: 'disabled' });
  // The production solved hold is 1600 ms; observe beyond it to catch premature resume.
  await page.waitForTimeout(2000);
  expect(await page.locator('video').evaluate(v => v.paused)).toBe(true);
  await app.release();
  await expect(page.getByText('You passed, and it can be faster')).toBeVisible();
  await expect(page.locator('.bp-complexity')).toContainText(analysisFixture.learner.time);
  await expect(page.locator('.bp-complexity')).toContainText(analysisFixture.best.time);
  await expect(page.locator('.bp-better-code')).toHaveCount(0);
  await page.waitForTimeout(2000);
  expect(await page.locator('video').evaluate(v => v.paused)).toBe(true);
  const toggle = page.getByRole('button', { name: 'Show a faster solution' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: info.outputPath('solved-slow.png'), animations: 'disabled' });
  await toggle.click();
  await expect(page.locator('.bp-better-code')).toHaveText(analysisFixture.betterSolution!);
  await expect(page.getByRole('button', { name: 'Hide a faster solution' })).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.bp-better-code').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('solved-slow-code.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Hide a faster solution' }).click();
  await expect(page.locator('.bp-better-code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume video', exact: true }).click();
  await expectPlaying(page);
});

test('efficient Submit shows its badge and automatically resumes', async ({ app }, info) => {
  const { page } = app;
  await automaticPause(page);
  await page.getByRole('textbox', { name: 'Python code' }).fill(correctCode);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.bp-efficiency.is-optimal')).toBeVisible();
  expect(app.analyses).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Show a faster solution' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('solved.png'), animations: 'disabled' });
  await expectPlaying(page);
});
