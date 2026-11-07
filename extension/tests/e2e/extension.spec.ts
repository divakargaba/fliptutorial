import { expect } from '@playwright/test';
import { automaticPause, correctCode, expectPlaying, test } from './extension.fixture';

test('built extension pauses once, Run fails, Submit passes and resumes', async ({ app }, info) => {
  const { page } = app;
  await automaticPause(page);
  const panel = page.locator('.bp-panel');
  expect(await panel.evaluate(el => getComputedStyle(el).fontSize)).toBe('14px');
  expect(await page.locator('.bp-body').evaluate(el => getComputedStyle(el).padding)).toBe('16px');
  expect(await panel.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('1px');
  const parent = await page.locator('breakpoint-practice').evaluate(el => el.parentElement?.id);
  expect(parent).toBe(info.project.name.includes('narrow') ? 'below' : 'secondary-inner');
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('editing.png') });
  const editor = page.getByRole('textbox', { name: 'Python code' });
  await editor.fill('');
  for (const key of ['Space', 'j', 'k', 'l', 'f']) await editor.press(key);
  expect(await page.evaluate(() => (window as Window & { pageHotkeys: number }).pageHotkeys)).toBe(0);
  await editor.press('Tab');
  await expect(page.getByRole('button', { name: 'Skip and watch' })).toBeFocused();
  await editor.fill('def raise_to_power(base, exponent):\n    return base * exponent');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('wrong answer', { exact: false })).toBeVisible();
  expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
  await page.locator('.bp-results').evaluate(el => el.scrollIntoView({ block: 'end' }));
  await page.locator('.bp-footer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('failed.png') });
  await editor.fill(correctCode);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Examples passed', { exact: false })).toBeVisible();
  expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expectPlaying(page);
  expect(app.requests.map(request => request.mode)).toEqual(['run', 'run', 'submit']);
  expect(app.requests[2]).toEqual({ mode: 'submit', exerciseId: 'samplevid01-exponent', revision: 'demo-1', code: correctCode });
  await expect(page.getByRole('button', { name: 'Breakpoint · 0 exercises' })).toBeVisible();
});

test('passed state remains reachable when browser refuses resume', async ({ app }, info) => {
  const { page } = app;
  await automaticPause(page);
  await app.rejectResume(true);
  await page.getByRole('textbox', { name: 'Python code' }).fill(correctCode);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Exercise complete', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume video' })).toBeVisible();
  expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
  await page.locator('.bp-results').evaluate(el => el.scrollIntoView({ block: 'end' }));
  await page.locator('.bp-footer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('passed.png') });
  await app.rejectResume(false);
  await page.getByRole('button', { name: 'Resume video' }).click();
  await expectPlaying(page);
});

test('Skip during pending grading ignores its late response', async ({ app }) => {
  const { page } = app;
  await automaticPause(page);
  app.hold = true;
  await page.getByRole('textbox', { name: 'Python code' }).fill(correctCode);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => app.requests.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Skip and watch' })).toBeEnabled();
  await page.getByRole('button', { name: 'Skip and watch' }).click();
  await expectPlaying(page);
  await app.release();
  const time = await page.locator('video').evaluate(video => video.currentTime);
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(time + 0.5);
  await expectPlaying(page);
});

test('badge opens practice and Chrome storage restores draft after reload', async ({ app }) => {
  const { page } = app;
  await page.locator('#start').click();
  await page.getByRole('button', { name: 'Breakpoint · 1 exercise' }).click();
  const editor = page.getByRole('textbox', { name: 'Python code' });
  await editor.fill('# recovered from chrome.storage.local');
  await page.getByRole('button', { name: 'Close practice' }).click();
  await expectPlaying(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Breakpoint · 1 exercise' })).toBeVisible();
  await page.getByRole('button', { name: 'Breakpoint · 1 exercise' }).click();
  await expect(editor).toContainText('# recovered from chrome.storage.local');
});

test('API failure preserves draft and Skip recovers playback', async ({ app }) => {
  const { page } = app;
  await automaticPause(page);
  app.unavailable = true;
  const editor = page.getByRole('textbox', { name: 'Python code' });
  await editor.fill(correctCode);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Fixture grader unavailable.', { exact: false })).toBeVisible();
  await expect(editor).toContainText('return base ** exponent');
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
  await page.getByRole('button', { name: 'Skip and watch' }).click();
  await expectPlaying(page);
});

test('ad crossing does not pause; practice stays available from badge', async ({ app }) => {
  const { page } = app;
  await page.locator('#movie_player').evaluate(el => el.classList.add('ad-showing'));
  await page.locator('#start').click();
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(1.8);
  await expectPlaying(page);
  await page.locator('#movie_player').evaluate(el => el.classList.remove('ad-showing'));
  await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(2.2);
  await expectPlaying(page);
  await page.getByRole('button', { name: 'Breakpoint · 1 exercise' }).click();
  await expect(page.locator('.bp-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Skip and watch' }).click();
  await expectPlaying(page);
});

test('navigation invalidates a pending attempt without resuming the next video', async ({ app }) => {
  const { page } = app;
  await automaticPause(page);
  app.hold = true;
  await page.getByRole('textbox', { name: 'Python code' }).fill(correctCode);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => app.requests.length).toBe(1);
  await page.evaluate(() => {
    history.pushState({}, '', '/watch?v=unknown0001');
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await expect(page.locator('.bp-panel')).toHaveCount(0);
  await expect(page.locator('.bp-badge')).toHaveCount(0);
  await app.release();
  await expect(page.locator('.bp-panel')).toHaveCount(0);
  expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
});
