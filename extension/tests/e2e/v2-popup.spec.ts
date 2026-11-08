import { expect } from '@playwright/test';
import { test } from './extension.fixture';

test('v2 built popup loads local profile and persists account and settings', async ({ app }, info) => {
  const context = app.page.context();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByRole('heading', { name: 'Ana (test)', level: 1 })).toBeVisible();
  await expect(popup.getByRole('progressbar', { name: 'Loops level progress' })).toHaveAttribute('value', '0.5625');
  await popup.getByLabel('Test account').selectOption('test-ben');
  await expect(popup.getByRole('heading', { name: 'Ben (test)', level: 1 })).toBeVisible();
  await popup.getByLabel('Pause frequency').selectOption('few');
  await popup.getByLabel('Automatically pause for practice').uncheck();
  await expect.poll(() => popup.evaluate(async () => {
    const api = (globalThis as typeof globalThis & { chrome: { storage: { local: { get(key: string): Promise<Record<string, { autoPause: boolean }>> } } } }).chrome;
    return (await api.storage.local.get('breakpoint:learner-settings'))['breakpoint:learner-settings']?.autoPause;
  })).toBe(false);
  await popup.reload();
  await expect(popup.getByRole('heading', { name: 'Ben (test)', level: 1 })).toBeVisible();
  await expect(popup.getByLabel('Pause frequency')).toHaveValue('few');
  await expect(popup.getByLabel('Automatically pause for practice')).not.toBeChecked();
  await popup.screenshot({ path: info.outputPath('profile-popup.png'), fullPage: true });
  await popup.close();
});
