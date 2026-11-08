import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { test, correctCode } from './extension.fixture';
import type { ExercisePlan } from '../../src/v2/types';

// Progress after a pass: the content script keeps the id of the passed / correct event it emitted,
// polls the B1 award endpoint (404 until the event is delivered), then shows what it earned.
const source: ExercisePlan = JSON.parse(readFileSync(new URL('../../../contracts/v2/exercise-plan.fixture.json', import.meta.url), 'utf8'));
const plan: ExercisePlan = {
  ...source, videoId: 'samplevid01',
  sections: source.sections.map(section => ({ ...section, startS: 0, endS: 20 })),
  pauses: source.pauses.map((pause, index) => ({ ...pause, pauseAtS: [2, 8, 14][index]!, revealAtS: pause.revealAtS === null ? null : [4, 10, 16][index]! })),
};

async function passCodingPause(page: Page) {
  await page.locator('#start').click();
  await expect(page.getByRole('heading', { name: 'Raise a number to a power' })).toBeVisible({ timeout: 12000 });
  await page.getByRole('textbox', { name: 'Python code' }).fill(correctCode);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Solved' })).toBeVisible();
}

test.describe('progress after a pass', () => {
  test.use({ plan, award: 'progress' });

  test('coding pass and correct concept answer show XP gained and progress to the next level', async ({ app }) => {
    const page = app.page;
    await passCodingPause(page);
    const card = page.getByRole('status', { name: 'Your progress' });
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card.getByText('+56 XP', { exact: true })).toBeVisible(); // 37.5 (Loops) + 18.8 (Functions)
    await expect(card.getByText('3 XP to Beginner II', { exact: false }).first()).toBeVisible();
    await expect(card.getByText('Loops', { exact: false }).first()).toBeVisible();
    await expect(card.getByText('Functions', { exact: false }).first()).toBeVisible();
    await expect(card.getByText('Level up!', { exact: false })).toHaveCount(0);
    // The award asked about exactly the passed event this attempt emitted, after it was delivered.
    const passed = app.events.find(e => e.type === 'passed');
    expect(passed).toBeTruthy();
    expect(app.awardRequests).toContain(passed!.id);
    expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);

    await page.getByRole('button', { name: 'Resume video', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reading a 2D list' })).toBeVisible({ timeout: 12000 });
    await page.getByRole('radio', { name: '3', exact: true }).check();
    await page.getByRole('button', { name: 'Check answer' }).click();
    await expect(page.getByRole('heading', { name: 'Well done' })).toBeVisible();
    const conceptCard = page.getByRole('status', { name: 'Your progress' });
    await expect(conceptCard.getByText('+38 XP', { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(conceptCard.getByText('Lists / arrays', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Resume video', exact: true }).click();
    await expect(page.locator('.bp-panel')).toHaveCount(0);
  });
});

test.describe('progress with a level-up', () => {
  test.use({ plan, award: 'levelUp' });

  test('a pass that crosses a level shows the level-up inside the progress card', async ({ app }) => {
    const page = app.page;
    await passCodingPause(page);
    const card = page.getByRole('status', { name: 'Your progress' });
    await expect(card.getByText('Level up! Loops · Beginner II')).toBeVisible({ timeout: 10000 });
    await expect(card.getByText('43 XP to Beginner III', { exact: false })).toBeVisible();
  });
});

test.describe('progress unavailable', () => {
  test.use({ plan });

  test('without an award the solved panel still works and nothing is invented', async ({ app }) => {
    const page = app.page;
    await passCodingPause(page);
    await expect.poll(() => app.awardRequests.length, { timeout: 10000 }).toBeGreaterThan(0);
    await expect(page.getByRole('status', { name: 'Your progress' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Resume video', exact: true }).click();
    await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
  });
});
