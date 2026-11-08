import { expect } from '@playwright/test';
import { analysisFixture, automaticPause, correctCode, expectPlaying, hintFixture, test } from './extension.fixture';

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
  await page.getByRole('button', { name: 'Skip and watch' }).click();
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
