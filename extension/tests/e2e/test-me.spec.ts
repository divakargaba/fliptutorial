import { expect } from '@playwright/test';
import { correctCode, expectPlaying, generated, test } from './extension.fixture';

test.describe('opt-in Test me through the built worker', () => {
  test.skip(process.env.WXT_TESTME_ENABLED !== 'true', 'Build with WXT_TESTME_ENABLED=true.');
  test.use({ preparedVideo: false });

  test('unprepared video pauses, generates, grades with setId and resumes', async ({ app }, info) => {
    const { page } = app;
    await expect(page.locator('[data-breakpoint-badge]')).toHaveCount(0);
    app.holdGeneration = true;
    await page.locator('#start').click();
    await page.getByRole('button', { name: 'Test me', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Creating your practice…' })).toBeFocused();
    await expect.poll(() => app.generations.length).toBe(1);
    const pausedAt = await page.locator('video').evaluate(v => v.currentTime);
    expect(await page.locator('video').evaluate(v => v.paused)).toBe(true);
    expect(app.generations[0].videoId).toBe('unknown0001');
    expect(app.generations[0].timestampS).toBeCloseTo(pausedAt, 2);
    await expect(page.getByText('AI-generated practice', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('test-me-loading.png') });
    await app.release();
    await expect(page.getByRole('heading', { name: generated.exercise.title })).toBeFocused();
    const editor = page.getByRole('textbox', { name: 'Python code' });
    await editor.fill('# wrong generated answer');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('Wrong answer', { exact: true })).toBeVisible();
    expect(await page.locator('video').evaluate(v => v.currentTime)).toBe(pausedAt);
    await expect(page.getByText('AI-generated practice', { exact: true })).toBeVisible();
    // The fixture grader recognizes this string; no Python or provider code runs.
    await editor.fill(correctCode);
    await app.rejectResume(true);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Solved', exact: true })).toBeVisible();
    await expect(page.getByText('AI-generated practice', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('test-me-solved.png') });
    expect(app.requests.map(({ exerciseId, revision, mode }) => ({ exerciseId, revision, mode }))).toEqual(
      ['run', 'submit'].map(mode => ({ exerciseId: generated.exercise.id, revision: generated.setId, mode })),
    );
    await expect(page.getByRole('button', { name: 'Resume video', exact: true })).toBeVisible();
    await app.rejectResume(false);
    await page.getByRole('button', { name: 'Resume video', exact: true }).click();
    await expectPlaying(page);
    await expect(page.getByRole('button', { name: 'Test me', exact: true })).toBeEnabled();
  });

  for (const failure of [
    { code: 'NO_CAPTIONS', status: 404, retryable: false },
    { code: 'NOT_PYTHON', status: 422, retryable: false },
    { code: 'TOO_EARLY', status: 422, retryable: false },
    { code: 'GENERATOR_UNAVAILABLE', status: 503, retryable: true },
    { code: 'GENERATOR_TIMEOUT', status: 504, retryable: true },
    { code: 'BUSY', status: 429, retryable: true },
  ]) {
    test(`${failure.code} keeps pause ownership and offers the appropriate recovery`, async ({ app }) => {
      const { page } = app;
      app.generationFailure = failure;
      await page.locator('#start').click();
      await page.getByRole('button', { name: 'Test me', exact: true }).click();
      await expect(page.getByText(`Fixture ${failure.code}.`, { exact: true })).toBeVisible();
      expect(await page.locator('video').evaluate(v => v.paused)).toBe(true);
      await expect(page.getByText('AI-generated practice', { exact: true })).toBeVisible();
      const retry = page.getByRole('button', { name: 'Try again', exact: true });
      if (failure.retryable) {
        app.generationFailure = null;
        await retry.click();
        await expect(page.getByRole('textbox', { name: 'Python code' })).toBeVisible();
        expect(app.generations).toHaveLength(2);
        expect(app.generations[1]).toEqual(app.generations[0]);
        await page.getByRole('button', { name: 'Skip and watch' }).click();
      } else {
        await expect(retry).toHaveCount(0);
        await page.getByRole('button', { name: 'Resume video', exact: true }).click();
      }
      await expectPlaying(page);
    });
  }

  for (const action of ['close', 'navigate', 'native play'] as const) {
    test(`${action} invalidates a pending generation`, async ({ app }) => {
      const { page } = app;
      app.holdGeneration = true;
      await page.locator('#start').click();
      await page.getByRole('button', { name: 'Test me', exact: true }).click();
      await expect.poll(() => app.generations.length).toBe(1);
      if (action === 'close') {
        await page.getByRole('button', { name: 'Close generated practice' }).click();
        await expectPlaying(page);
      } else if (action === 'navigate') {
        await page.evaluate(() => {
          history.pushState({}, '', '/watch?v=unknown0002');
          document.dispatchEvent(new Event('yt-navigate-finish'));
        });
      } else await page.locator('video').evaluate(v => v.play());
      await expect(page.locator('.bp-panel')).toHaveCount(0);
      await app.release();
      await expect(page.locator('.bp-panel')).toHaveCount(0);
      expect(await page.locator('video').evaluate(v => v.paused)).toBe(action === 'navigate');
    });
  }

  test('expired set keeps its draft, blocks resubmission and restores Chrome storage', async ({ app }) => {
    const { page } = app;
    await page.locator('#start').click();
    await page.getByRole('button', { name: 'Test me', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Python code' });
    const draft = '# keep my generated draft';
    await editor.fill(draft);
    app.failure = { code: 'SET_EXPIRED', status: 410, retryable: false };
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Practice expired', { exact: true })).toBeVisible();
    await expect(editor).toHaveText(draft);
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
    await editor.press('Control+Enter');
    expect(app.requests).toHaveLength(1);
    expect(await page.locator('video').evaluate(v => v.paused)).toBe(true);
    await page.getByRole('button', { name: 'Skip and watch' }).click();
    await expectPlaying(page);
    await page.reload();
    await page.getByRole('button', { name: 'Test me', exact: true }).click();
    await expect(editor).toHaveText(draft);
  });
});

test('Test me default build stays hidden', async ({ app }) => {
  test.skip(process.env.WXT_TESTME_ENABLED === 'true', 'Default-build check.');
  await expect(app.page.getByRole('button', { name: 'Test me', exact: true })).toHaveCount(0);
});
