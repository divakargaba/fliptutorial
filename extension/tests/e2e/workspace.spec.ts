import { expect } from '@playwright/test';
import { automaticPause, test } from './extension.fixture';

test('placement moves the mounted workspace, preserves edits and is remembered', async ({ app }, info) => {
  const page = app.page;
  await automaticPause(page);
  const editor = page.getByRole('textbox', { name: 'Python code' });
  const draft = 'def raise_to_power(base, exponent):\n    return base ** exponent # my draft';
  await editor.fill(draft);
  await expect(page.locator('.breakpoint-shell')).toHaveAttribute('data-placement', 'below');
  await expect(page.getByText('Practice settings', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-breakpoint-badge]')).not.toBeVisible();
  await page.locator('.bp-workbench').screenshot({ animations: 'disabled', path: info.outputPath('workbench-below.png') });
  await editor.evaluate(el => { el.dataset.mountProof = 'same-editor'; });
  await page.getByRole('button', { name: 'Side', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Side', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.breakpoint-shell')).toHaveAttribute('data-placement', info.project.name.endsWith('narrow') ? 'below' : 'side');
  await expect(editor).toHaveAttribute('data-mount-proof', 'same-editor');
  await expect(editor).toHaveText(draft);
  expect(await page.locator('video').evaluate(video => video.paused)).toBe(true);
  await page.locator('.bp-workbench').screenshot({ animations: 'disabled', path: info.outputPath('workbench-side.png') });
  const extensionId = new URL(page.context().serviceWorkers()[0]!.url()).host;
  const storagePage = await page.context().newPage();
  await storagePage.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect.poll(() => storagePage.evaluate(async code => Object.values(await chrome.storage.local.get(null)).includes(code), draft)).toBe(true);
  await storagePage.close();
  await page.reload();
  await automaticPause(page);
  await expect(page.getByRole('button', { name: 'Side', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(editor).toHaveText(draft);
  await page.getByRole('button', { name: 'Below', exact: true }).click();
  await expect(page.locator('.breakpoint-shell')).toHaveAttribute('data-placement', 'below');
});

test('hints overlay without resizing the editor and reopen without another request', async ({ app }, info) => {
  const page = app.page;
  await automaticPause(page);
  const editor = page.getByRole('textbox', { name: 'Python code' });
  const before = await page.locator('.bp-editor-card').boundingBox();
  await page.getByRole('button', { name: 'Stuck? Get a hint', exact: true }).click();
  await expect(page.locator('.bp-hint-card')).toHaveCount(1);
  const after = await page.locator('.bp-editor-card').boundingBox();
  expect(Math.abs(after!.height - before!.height)).toBeLessThan(1); // subpixel entry animation

  await page.locator('.bp-workbench').screenshot({ animations: 'disabled', path: info.outputPath('workbench-hint.png') });
  await page.getByRole('button', { name: 'Back to code', exact: true }).click();
  await expect(editor).toBeFocused();
  await expect(page.locator('.bp-help-popover')).toHaveCount(0);
  await page.getByRole('button', { name: 'Hints (1 of 3)', exact: true }).click();
  await expect(page.locator('.bp-hint-card')).toHaveCount(1);
  expect(app.hints).toHaveLength(1);
  await editor.fill('def raise_to_power(base, exponent):\n    return base ** exponent');
  await expect(page.locator('.bp-help-popover')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.bp-celebration-check')).toBeVisible();
  expect(await page.locator('.bp-celebration-check').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.locator('.bp-workbench').screenshot({ animations: 'disabled', path: info.outputPath('workbench-success.png') });
});
