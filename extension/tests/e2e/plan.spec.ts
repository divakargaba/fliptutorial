import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test, correctCode } from './extension.fixture';
import type { ExercisePlan } from '../../src/v2/types';

const source: ExercisePlan = JSON.parse(readFileSync(new URL('../../../contracts/v2/exercise-plan.fixture.json', import.meta.url), 'utf8'));
const plan: ExercisePlan = {
  ...source, videoId: 'samplevid01',
  sections: source.sections.map(section => ({ ...section, startS: 0, endS: 20 })),
  pauses: source.pauses.map((pause, index) => ({ ...pause, pauseAtS: [2, 8, 14][index]!, revealAtS: pause.revealAtS === null ? null : [4, 10, 16][index]! })),
};

test.describe('v2 refresher runtime', () => {
  const question = { ...source.pauses[1]!.question!, id: 'rf-lists-browser' };
  test.use({
    plan: { ...plan, pauses: [] },
    refresher: { accountId: 'test-ana', concept: 'lists', conceptName: 'Lists', strength: 0.2,
      reason: 'A short review will keep lists fresh.', question },
  });

  test('offered refresher opens a question, records its answer and waits for explicit Resume', async ({ app }) => {
    const page = app.page;
    await expect(page.getByRole('complementary', { name: 'Skill refresher' })).toBeVisible();
    await page.locator('#start').click();
    await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
    await page.getByRole('button', { name: 'Practice', exact: true }).click();
    await expect(page.getByRole('heading', { name: question.title })).toBeVisible();
    expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
    await page.getByRole('radio', { name: '3', exact: true }).check();
    await page.getByRole('button', { name: 'Check answer', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Well done' })).toBeVisible();
    expect(app.answers).toEqual([{ questionId: question.id, revision: question.revision, answer: 'c', learnerLevel: 'beginner-1' }]);
    await expect.poll(() => app.events.filter(event => event.type === 'refresher_answered').length).toBe(1);
    expect(app.events.find(event => event.type === 'refresher_answered')).toMatchObject({
      accountId: 'test-ana', exerciseId: question.id, concepts: ['lists'], correct: true,
    });
    expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
    await page.getByRole('button', { name: 'Resume video', exact: true }).click();
    await expect(page.getByRole('heading', { name: question.title })).toHaveCount(0);
    await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
    expect(app.events.filter(event => event.type === 'refresher_answered')).toHaveLength(1);
    expect(app.events.filter(event => event.type === 'passed' || event.type === 'failed')).toHaveLength(0);
  });
});

test.describe('v2 plan retry recovery', () => {
  test.use({ plan, planErrors: 1 });

  test('terminal plan error retries the personalized plan and opens coding practice', async ({ app }) => {
    const page = app.page;
    await expect(page.locator('[data-breakpoint-badge] .bp-badge')).toHaveAttribute('data-state', 'unavailable');
    expect(app.planRequests).toHaveLength(1);
    const lookups = app.lookupCount;
    await page.locator('[data-breakpoint-badge] .bp-badge').click();
    await expect(page.locator('[data-breakpoint-badge] .bp-badge')).toHaveAttribute('data-state', 'ready');
    expect(app.planRequests).toHaveLength(2);
    expect(app.planRequests[1]).toEqual(app.planRequests[0]);
    expect(app.planRequests[1]!.learnerLevels.loops).toBe('beginner-1');
    expect(app.lookupCount).toBe(lookups);
    await page.locator('#start').click();
    await expect(page.getByRole('heading', { name: 'Raise a number to a power' })).toBeVisible();
    expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
  });
});

test.describe('v2 late player recovery', () => {
  test.use({ plan, delayedPlayer: true });

  test('real media becoming ready after the bind deadline clears the stale badge automatically', async ({ app }) => {
    const page = app.page;
    await expect(page.locator('[data-breakpoint-badge] .bp-badge')).toHaveAttribute('data-state', 'unavailable', { timeout: 10000 });
    expect(await page.locator('video').evaluate(video => video.readyState)).toBe(0);
    await page.evaluate(() => (window as unknown as { readyFixtureMedia(): void }).readyFixtureMedia());
    await expect.poll(() => page.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
    await expect(page.locator('[data-breakpoint-badge] .bp-badge')).toHaveAttribute('data-state', 'ready');
    expect(app.planRequests).toHaveLength(1);
    await page.locator('#start').click();
    await expect(page.getByRole('heading', { name: 'Raise a number to a power' })).toBeVisible();
    await expect(page.locator('.bp-panel')).toBeVisible();
    await expect(page.locator('[data-breakpoint-badge] .bp-badge')).not.toBeVisible();
    expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
  });
});

test.describe('v2 plan runtime', () => {
  test.use({ plan, planningPolls: 1 });

  test('planning becomes ready, then coding and concept pauses keep feedback until Resume', async ({ app }) => {
    const page = app.page;
    await expect(page.getByRole('button', { name: 'Breakpoint · finding practice' })).toBeVisible();
    await expect.poll(() => app.planRequests.length, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
    expect(app.planRequests[1]).toEqual(app.planRequests[0]);
    const markers = page.locator('.bp-timeline-marker');
    await expect(markers).toHaveCount(2); // The unready third pause stays absent.
    const rail = page.locator('breakpoint-timeline');
    await expect(rail).toHaveCSS('position', 'absolute');
    const bar = await page.locator('.ytp-progress-bar').boundingBox();
    for (const [index, time] of [2, 8].entries()) {
      const marker = await markers.nth(index).boundingBox();
      expect(Math.abs(marker!.x + marker!.width / 2 - (bar!.x + bar!.width * time / 20))).toBeLessThan(2);
      expect(marker!.y + marker!.height).toBeLessThanOrEqual(bar!.y);
    }
    await page.locator('#start').click();
    await expect(page.getByRole('heading', { name: 'Raise a number to a power' })).toBeVisible();
    await expect(rail).toBeHidden();
    expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
    await page.getByRole('textbox', { name: 'Python code' }).fill(correctCode);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    const feedback = page.getByRole('region', { name: 'Practice feedback' });
    await expect(feedback.getByText('This tested accumulating a result across loop iterations.', { exact: true })).toHaveCount(1);
    expect(app.requests[0]).toMatchObject({ exerciseId: plan.pauses[0]!.exercise!.id, revision: 'r1', language: 'python', mode: 'submit', code: correctCode });
    expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
    await page.getByRole('button', { name: 'Resume video', exact: true }).click();
    await expect(rail).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reading a 2D list' })).toBeVisible({ timeout: 12000 });
    await expect(rail).toBeHidden();
    await page.getByRole('radio', { name: '3', exact: true }).check();
    await page.getByRole('button', { name: 'Check answer' }).click();
    await expect(page.getByRole('heading', { name: 'Well done' })).toBeVisible();
    expect(app.answers[0]).toMatchObject({ questionId: plan.pauses[1]!.question!.id, answer: 'c' });
    expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
    await page.getByRole('button', { name: 'Resume video', exact: true }).click();
    await expect(page.locator('.bp-panel')).toHaveCount(0);
    await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
  });
});

for (const status of ['not_coding', 'no_captions'] as const) {
  test.describe(`v2 plan ${status}`, () => {
    const reason = status === 'not_coding' ? 'This video discusses careers instead of teaching code.' : 'No captions are available for this video.';
    test.use({ plan: { ...plan, status, verdict: { qualifies: false, reason, evidence: [] }, sections: [], pauses: [] } });
    test('explains unavailability and leaves playback available', async ({ app }) => {
      await expect(app.page.getByRole('heading', { name: 'Topic not available' })).toBeVisible();
      await expect(app.page.getByText(reason, { exact: true })).toBeVisible();
      await app.page.locator('#start').click();
      await expect.poll(() => app.page.locator('video').evaluate(video => video.paused)).toBe(false);
      await expect(app.page.locator('.bp-panel')).toHaveCount(0);
      await app.page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await expect(app.page.getByRole('heading', { name: 'Topic not available' })).toHaveCount(0);
    });
  });
}

test.describe('v2 plan preferences', () => {
  test.use({ plan });
  test('settings update scheduling and account changes request the selected learner levels', async ({ app }) => {
    const page = app.page;
    await expect(page.locator('.bp-timeline-marker')).toHaveCount(2);
    const context = page.context();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.getByRole('button', { name: 'Settings', exact: true }).click();
    await popup.getByRole('radio', { name: 'Fewer', exact: true }).click();
    await expect(page.locator('.bp-timeline-marker')).toHaveCount(1);
    await popup.getByRole('switch', { name: /Pause for practice/ }).uncheck();
    await popup.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.bringToFront();
    await page.locator('#start').click();
    await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(3);
    expect(await page.locator('video').evaluate(video => video.paused)).toBe(false);
    await expect(page.locator('.bp-panel')).toHaveCount(0);
    await popup.getByLabel('Viewing as').selectOption('test-ben');
    await expect.poll(() => app.planRequests.at(-1)?.learnerLevels.loops).toBe('intermediate-1');
    await expect(popup.getByRole('heading', { name: 'Ben', exact: true, level: 1 })).toBeVisible();
    await popup.close();
  });
});
