import { expect } from '@playwright/test';
import { automaticPause, correctCode, expectPlaying, test } from './extension.fixture';
import { auditPanel } from './panel-audit';

const failures = [
  { code: 'GRADER_UNAVAILABLE', status: 503, retryable: true, title: 'Grader unavailable' },
  { code: 'GRADER_TIMEOUT', status: 504, retryable: true, title: 'Grading timed out' },
  { code: 'BUSY', status: 429, retryable: true, title: 'Grader is busy' },
  { code: 'STALE_EXERCISE', status: 409, retryable: true, title: 'Exercise updated' },
  { code: 'INVALID_CODE', status: 422, retryable: false, title: 'Check your code' },
  { code: 'TIMEOUT', status: 0, retryable: true, title: 'Request timed out' },
];

for (const failure of failures) {
  test(`${failure.code}: draft survives, playback stays paused, keyboard Skip works`, async ({ app }, info) => {
    test.setTimeout(45_000);
    const { page } = app;
    await automaticPause(page);
    const editor = page.getByRole('textbox', { name: 'Python code' });
    const draft = `${correctCode}\n# keep this draft after ${failure.code}`;
    await editor.fill(draft);
    if (failure.code === 'TIMEOUT') app.hold = true; // Exercise the real 15 s worker fetch deadline.
    else app.failure = failure;
    if (failure.code === 'STALE_EXERCISE') app.revision = 'demo-2';
    const lookups = app.lookupCount;
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect.poll(() => app.requests.length).toBe(1);
    const skip = page.getByRole('button', { name: 'More', exact: true });
    await expect(skip).toBeEnabled();
    await expect(page.getByText(failure.title, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n')).toBe(draft);
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
    const pausedAt = await page.locator('video').evaluate(v => v.currentTime);
    expect(await page.locator('video').evaluate(v => v.paused)).toBe(true);
    if (failure.code === 'STALE_EXERCISE') {
      await expect(page.getByRole('heading', { name: 'Updated exponent challenge' })).toBeVisible();
      expect(app.lookupCount).toBeGreaterThan(lookups);
      app.failure = null;
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(page.getByText('Wrong answer', { exact: true })).toBeVisible();
      expect(app.requests[1]).toMatchObject({ revision: 'demo-2', code: draft });
      // Restore the refreshed error for the screenshot, without changing the draft.
      app.failure = failure;
      await page.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect(page.getByText(failure.title, { exact: true })).toBeVisible();
    }
    await page.locator('.bp-results').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${failure.code}.png`), animations: 'disabled' });
    // Tab leaves CodeMirror for the hint coach, then reaches Skip, including after a revision remount.
    await editor.focus();
    await editor.press('Tab');
    await expect(page.getByRole('button', { name: 'Stuck? Get a hint' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(skip).toBeFocused();
    expect(await page.locator('video').evaluate(v => v.currentTime)).toBe(pausedAt);
    await skip.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Practice later', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expectPlaying(page);
    await page.reload();
    await page.getByRole('button', { name: /^Breakpoint/ }).click();
    await expect.poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n')).toBe(draft); // Chrome storage, including the refreshed revision key.
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} panel meets AA text contrast and accessible control checks`, async ({ app }, info) => {
    const { page } = app;
    await page.evaluate(theme => document.documentElement.toggleAttribute('dark', theme === 'dark'), theme);
    await automaticPause(page);
    await expect(page.locator('.breakpoint-shell')).toHaveAttribute('data-theme', theme);
    const editor = page.getByRole('textbox', { name: 'Python code' });
    await page.getByRole('heading', { name: 'Raise a number to a power' }).press('Tab');
    const instructions = page.getByText('Instructions & examples', { exact: true });
    await expect(instructions).toBeFocused();
    await instructions.press('Tab');
    await expect(editor).toBeFocused();
    await editor.press('Tab');
    await expect(page.getByRole('button', { name: 'Stuck? Get a hint' })).toBeFocused();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('button', { name: 'More', exact: true });
    await expect(skip).toBeFocused();
    expect(await skip.evaluate(el => getComputedStyle(el).outlineWidth)).toBe('2px');
    await editor.fill('# A readable comment\ndef raise_to_power(base, exponent):\n    return 2 ** exponent');
    const reports = [];
    for (const state of ['editing', 'wrong', 'error', 'solved']) {
      if (state === 'wrong') {
        await page.getByRole('button', { name: 'Run', exact: true }).click();
        await expect(page.getByText('Wrong answer', { exact: true })).toBeVisible();
      } else if (state === 'error') {
        app.unavailable = true;
        await page.getByRole('button', { name: 'Submit', exact: true }).click();
        await expect(page.getByText('Grader unavailable', { exact: true })).toBeVisible();
      } else if (state === 'solved') {
        app.unavailable = false;
        await app.rejectResume(true);
        await editor.fill(correctCode);
        await page.getByRole('button', { name: 'Submit', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Resume video' })).toBeVisible();
      }
      const report = await auditPanel(page);
      reports.push({ state, ...report });
      expect(report.contrastFailures, `${theme} ${state} text contrast`).toEqual([]);
      expect(report.controlFailures, `${theme} ${state} controls`).toEqual([]);
      expect(report.checkedTextNodes).toBeGreaterThan(state === 'solved' ? 3 : 8);
      await page.screenshot({ path: info.outputPath(`${theme}-${state}.png`), animations: 'disabled' });
    }
    await info.attach(`${theme}-accessibility.json`, { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
  });
}
