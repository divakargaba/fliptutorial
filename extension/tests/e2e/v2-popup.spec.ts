import { expect } from '@playwright/test';
import { test } from './extension.fixture';

test('v2 built popup loads local profile and persists account and settings', async ({ app }, info) => {
  const context = app.page.context();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByRole('heading', { name: 'Ana', exact: true, level: 1 })).toBeVisible();
  await expect(popup.getByRole('progressbar', { name: 'Loops level progress' })).toHaveAttribute('aria-valuenow', '56');
  await popup.getByLabel('Viewing as').selectOption('test-ben');
  await expect(popup.getByRole('heading', { name: 'Ben', exact: true, level: 1 })).toBeVisible();
  await popup.getByRole('button', { name: 'Settings' }).click();
  await popup.getByRole('radio', { name: 'Fewer' }).click();
  await popup.getByRole('switch', { name: /Pause for practice/ }).uncheck();
  await expect.poll(() => popup.evaluate(async () => {
    const api = (globalThis as typeof globalThis & { chrome: { storage: { local: { get(key: string): Promise<Record<string, { autoPause: boolean }>> } } } }).chrome;
    return (await api.storage.local.get('breakpoint:learner-settings'))['breakpoint:learner-settings']?.autoPause;
  })).toBe(false);
  await popup.reload();
  await expect(popup.getByRole('heading', { name: 'Ben', exact: true, level: 1 })).toBeVisible();
  await popup.getByRole('button', { name: 'Settings' }).click();
  await expect(popup.getByRole('radio', { name: 'Fewer' })).toHaveAttribute('aria-checked', 'true');
  await expect(popup.getByRole('switch', { name: /Pause for practice/ })).not.toBeChecked();
  await popup.screenshot({ path: info.outputPath('profile-popup.png'), fullPage: true });
  await popup.close();
});
