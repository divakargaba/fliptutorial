import { expect, type Page } from '@playwright/test';
import { automaticPause, correctCode, unlockHints, test } from './extension.fixture';
import { readFileSync } from 'node:fs';

async function popupFor(page: Page) {
  const popup = await page.context().newPage();
  await popup.goto(`chrome-extension://${new URL(page.context().serviceWorkers()[0]!.url()).host}/popup.html`);
  return popup;
}

test('distinct completed edits unlock hints; errors and identical retries do not', async ({ app }, info) => {
  const { page } = app;
  await automaticPause(page);
  const editor = page.getByRole('textbox', { name: 'Python code' });
  const gate = page.getByRole('button', { name: /Hints locked/ });
  await expect(gate).toBeDisabled();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('What went wrong', { exact: true })).toBeInViewport();
  await expect(gate).toHaveAccessibleName('Hints locked: 0 of 2 attempts');
  await page.getByRole('button', { name: 'Back to code', exact: true }).click();
  const code = 'def raise_to_power(base, exponent):\n    return base * exponent';
  await editor.fill(code);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('What went wrong', { exact: true })).toBeInViewport();
    await expect(gate).toHaveAccessibleName('Hints locked: 1 of 2 attempts');
    await page.getByRole('button', { name: 'Back to code', exact: true }).click();
  }
  app.failure = { status: 503, code: 'GRADER_TIMEOUT', retryable: true };
  await editor.fill('def raise_to_power(base, exponent):\n    return base + exponent');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Could not check your solution')).toBeVisible();
  await expect(gate).toHaveAccessibleName('Hints locked: 1 of 2 attempts');
  app.failure = null;
  await page.getByRole('button', { name: 'Back to code', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('What went wrong', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Stuck? Get a hint', exact: true })).toBeEnabled();
  await page.locator('.bp-workbench').screenshot({ path: info.outputPath('feedback-drawer.png'), animations: 'disabled' });
  await editor.fill(code + ' # working');
  await expect(page.locator('.bp-feedback-drawer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await expect(page.getByText('What went wrong', { exact: true })).toBeInViewport();
  await page.reload(); await automaticPause(page);
  await expect(page.getByRole('button', { name: 'Stuck? Get a hint', exact: true })).toBeEnabled();
});

test('each new hint needs fresh attempts while saved hints stay readable', async ({ app }) => {
  const page = app.page;
  await automaticPause(page);
  await unlockHints(page);
  await page.getByRole('button', { name: 'Stuck? Get a hint', exact: true }).click();
  await expect(page.getByText('Hint 1 of 3', { exact: true })).toBeVisible();
  const next = page.getByRole('button', { name: 'Next hint (2 of 3)', exact: true });
  await expect(next).toBeDisabled();
  await page.getByRole('button', { name: 'Back to code', exact: true }).click();
  // Replaying either of the earlier solutions does not earn a new hint.
  await page.getByRole('textbox', { name: 'Python code' }).fill('def raise_to_power(base, exponent):\n    return base * exponent');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('What went wrong', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to code', exact: true }).click();
  await page.getByRole('button', { name: 'Hints (1 of 3)', exact: true }).click();
  await expect(page.getByText(/0 of 2 attempts completed/)).toBeVisible();
  await expect(next).toBeDisabled();
  expect(app.hints.filter(h => h.level > 0)).toHaveLength(1);
  await unlockHints(page, 1);
  await next.click();
  await expect(page.getByText('Hint 2 of 3', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next hint (3 of 3)', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Hint 1', exact: true }).click();
  await expect(page.getByText('Hint 1 of 3', { exact: true })).toBeVisible();
  expect(app.hints.filter(h => h.level > 0).map(h => h.level)).toEqual([1, 2]);
  expect(app.events.filter(event => event.type !== 'watched')).toEqual([]);
  expect(app.awardRequests).toEqual([]);
});

test('history captures submitted code, isolates accounts, exports and deletes without progress writes', async ({ app }, info) => {
  const { page } = app;
  await automaticPause(page);
  const editor = page.getByRole('textbox', { name: 'Python code' });
  await editor.fill(correctCode);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Run complete', { exact: true })).toBeVisible();
  const popup = await popupFor(page);
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(popup.getByText('Your learning trail starts here')).toBeVisible();
  await page.bringToFront();
  await page.getByRole('button', { name: 'Back to code', exact: true }).click();
  app.hold = true;
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => app.requests.length).toBe(2);
  const laterDraft = correctCode + ' # edited after submission';
  await editor.fill(laterDraft);
  await app.release();
  await expect(page.getByText('Solution saved to local history.')).toBeVisible();
  await popup.reload();
  await expect(popup.getByRole('heading', { name: 'Ana', exact: true })).toBeVisible();
  await popup.screenshot({ path: info.outputPath('learning-home.png'), animations: 'disabled' });
  await popup.getByRole('tab', { name: 'History', exact: true }).click();
  await popup.getByRole('button', { name: /Raise a number to a power/ }).click();
  await expect(popup.locator('.bp-learning-code')).toHaveText(correctCode);
  await expect(popup.getByRole('link', { name: 'Practice again' })).toHaveAttribute('href', /bp_review=/);
  const events = JSON.stringify(app.events.filter(e => e.type !== 'watched'));
  await popup.screenshot({ path: info.outputPath('saved-solution.png'), animations: 'disabled' });
  const download = popup.waitForEvent('download');
  await popup.getByRole('button', { name: 'Export', exact: true }).click();
  const exported = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
  expect(exported.code).toBe(correctCode); expect(exported.accountId).toBe('test-ana');
  await popup.getByLabel('Viewing as').selectOption('test-ben');
  await popup.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(popup.getByText('Your learning trail starts here')).toBeVisible();
  await popup.getByLabel('Viewing as').selectOption('test-ana');
  await popup.getByRole('tab', { name: 'History', exact: true }).click();
  await popup.getByRole('button', { name: /Raise a number to a power/ }).click();
  await popup.getByRole('button', { name: 'Delete', exact: true }).click();
  await popup.getByRole('button', { name: 'Delete solution', exact: true }).click();
  await expect(popup.getByText('Your learning trail starts here')).toBeVisible();
  expect(JSON.stringify(app.events.filter(e => e.type !== 'watched'))).toBe(events);
  const saved = await popup.evaluate(() => chrome.storage.local.get(null));
  expect(Object.values(saved)).toContain(laterDraft);
  expect(Object.keys(saved).filter(k => k.startsWith('breakpoint:history:'))).toEqual([]);
});

const source = JSON.parse(readFileSync(new URL('../../../contracts/v2/exercise-plan.fixture.json', import.meta.url), 'utf8'));
test.describe('popup manual review', () => {
  const question = { ...source.pauses[1].question, id: 'rf-loops-popup', concepts: ['loops'] };
  test.use({ refresher: { accountId: 'test-ana', concept: 'loops', conceptName: 'Loops', strength: .9, reason: 'Requested review', question } });
  test('skill detail reviews use existing grader and send no XP events', async ({ app }, info) => {
    const popup = await popupFor(app.page);
    await popup.setViewportSize({ width: 400, height: 600 });
    await popup.getByRole('tab', { name: 'Skills', exact: true }).click();
    await popup.getByRole('button', { name: 'Loops', exact: true }).click();
    await popup.screenshot({ path: info.outputPath('skill-detail.png'), animations: 'disabled' });
    await popup.getByRole('button', { name: 'Review skill', exact: true }).click();
    await expect(popup.getByRole('heading', { name: question.title })).toBeVisible();
    await popup.getByRole('radio', { name: '3', exact: true }).check();
    app.answerWrong = true;
    await popup.getByRole('button', { name: 'Check answer', exact: true }).click();
    await expect(popup.getByRole('region', { name: 'Practice feedback' })).toBeVisible();
    expect(app.events).toEqual([]);
    app.answerWrong = false;
    await popup.getByRole('button', { name: 'Check answer', exact: true }).click();
    await expect(popup.getByRole('heading', { name: 'Well done' })).toBeVisible();
    expect(app.answers).toHaveLength(2); expect(app.events).toEqual([]);
    await popup.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(popup.getByRole('button', { name: 'Review skill', exact: true })).toBeVisible();
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test('switching account ignores an answer already in flight', async ({ app }) => {
    const popup = await popupFor(app.page);
    await popup.getByRole('button', { name: 'Loops', exact: true }).click();
    await popup.getByRole('button', { name: 'Review skill', exact: true }).click();
    await popup.getByRole('radio', { name: '3', exact: true }).check();
    app.hold = true;
    await popup.getByRole('button', { name: 'Check answer', exact: true }).click();
    await expect.poll(() => app.answers.length).toBe(1);
    await popup.getByLabel('Viewing as').selectOption('test-ben');
    await expect(popup.getByRole('heading', { name: 'Ben', exact: true })).toBeVisible();
    await app.release();
    await expect(popup.getByRole('heading', { name: 'Well done' })).toHaveCount(0);
    expect(app.events).toEqual([]);
    await popup.getByRole('button', { name: 'Loops', exact: true }).click();
    await popup.getByRole('button', { name: 'Review skill', exact: true }).click();
    await expect(popup.getByText(/No review question is available/)).toBeVisible();
  });
});


test.describe('saved lesson review and position', () => {
  const plan = { ...source, videoId: 'samplevid01',
    sections: source.sections.map((section: object) => ({ ...section, startS: 0, endS: 20 })),
    pauses: source.pauses.slice(0, 2).map((pause: object, index: number) => ({ ...pause, pauseAtS: [2, 8][index], revealAtS: [4, 10][index] })) };
  test.use({ plan, seekableVideo: true });
  test('saved practice seeks and reopens without restoring over drafts or awarding again', async ({ app }) => {
    const page = app.page;
    await page.locator('#start').click();
    await expect(page.locator('.bp-panel').getByText('Challenge 1 of 2', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Python code' }).fill(correctCode);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Solution saved to local history.')).toBeVisible();
    await expect.poll(() => app.events.filter(e => e.type === 'passed').length).toBe(1);
    const popup = await popupFor(page);
    await popup.getByRole('tab', { name: 'History', exact: true }).click();
    await popup.getByRole('button', { name: /Raise a number to a power/ }).click();
    const href = await popup.getByRole('link', { name: 'Practice again' }).getAttribute('href');
    await popup.close();
    await page.getByRole('button', { name: 'Resume video', exact: true }).click();
    await page.locator('video').evaluate(v => v.pause());
    await page.goto(href!);
    await expect(page.getByText('Reviewing challenge 1 of 2', { exact: true })).toBeVisible({ timeout: 10000 });
    expect(await page.locator('video').evaluate(v => v.currentTime)).toBeCloseTo(2, 0);
    await expect(page.getByRole('textbox', { name: 'Python code' })).toHaveText(correctCode);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume video', exact: true })).toBeVisible();
    expect(app.events.filter(e => e.type === 'passed')).toHaveLength(1);
    // Read-only award polling can retry before the event ACK; review must not
    // create a second event or ask for an award for a different event.
    expect([...new Set(app.awardRequests)]).toEqual([app.events.find(e => e.type === 'passed')!.id]);
  });
});

test.describe('challenge counters', () => {
  test.use({ breakpointCount: 2 });
  test('position follows skipped challenges while solved count stays separate', async ({ app }) => {
    const page = app.page;
    await automaticPause(page);
    await expect(page.locator('.bp-panel').getByText('Challenge 1 of 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Practice later', exact: true }).click();
    await expect(page.locator('.bp-panel').getByText('Challenge 2 of 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Practice later', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Breakpoint · 0 of 2 solved' })).toContainText('0 solved · 2 skipped');
  });
});
