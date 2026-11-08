import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './extension.fixture';
import type { ExercisePlan } from '../../src/v2/types';

// On a short window the panels are capped at the viewport height. The concept panel used to clip its
// answer feedback and its action buttons below the fold (only visible when zoomed far out); its body
// now scrolls and the actions stay pinned, like the coding panel's footer.
const source: ExercisePlan = JSON.parse(readFileSync(new URL('../../../contracts/v2/exercise-plan.fixture.json', import.meta.url), 'utf8'));
const plan: ExercisePlan = {
  ...source, videoId: 'samplevid01',
  sections: source.sections.map(section => ({ ...section, startS: 0, endS: 20 })),
  pauses: source.pauses.map((pause, index) => ({ ...pause, pauseAtS: [2, 8, 14][index]!, revealAtS: pause.revealAtS === null ? null : [4, 10, 16][index]! })),
};

test.describe('panels fit a short window', () => {
  test.use({ plan, award: 'progress', viewport: { width: 1280, height: 600 } });

  test('concept panel keeps Check answer and Resume video reachable after feedback', async ({ app }) => {
    const page = app.page;
    await page.locator('#start').click();
    await expect(page.getByRole('heading', { name: 'Raise a number to a power' })).toBeVisible({ timeout: 12000 });
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Practice later', exact: true }).click(); // on to the concept question
    await expect(page.getByRole('heading', { name: 'Reading a 2D list' })).toBeVisible({ timeout: 12000 });
    const check = page.getByRole('button', { name: 'Check answer' });
    await expect(check).toBeInViewport();
    await page.getByRole('radio', { name: '3', exact: true }).check();
    await check.click();
    await expect(page.getByRole('heading', { name: 'Well done' })).toBeAttached();
    await expect(page.getByRole('status', { name: 'Your progress' })).toBeAttached({ timeout: 10000 });
    // Feedback and progress made the content taller than the capped panel: the actions stay on screen.
    const resume = page.getByRole('button', { name: 'Resume video', exact: true });
    await expect(resume).toBeInViewport();
    // The bug was the actions being clipped *inside* the capped panel: Resume must sit within its bottom edge.
    // (Where the panel itself ends depends on what sits above it and font metrics, and YouTube's page scrolls.)
    const panel = await page.locator('.bp-panel').boundingBox();
    const button = await resume.boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(panel!.y + panel!.height + 1);
    // Everything else is still reachable by scrolling inside the panel.
    const body = page.locator('.bp-v2.bp-panel > .bp-v2-body');
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.getByRole('heading', { name: 'Well done' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('heading', { name: 'Well done' })).toBeInViewport();
    await resume.click();
    await expect(page.locator('.bp-panel')).toHaveCount(0);
  });
});
