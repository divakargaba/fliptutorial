import { browser } from 'wxt/browser';
import { ACCOUNT_KEY, SETTINGS_KEY, readAccount, readSettings, SettingsSchema, type LearnerSettings } from './settings';

// B2 calls these helpers from the popup/settings UI. Storage errors deliberately
// propagate so the UI can report an unsuccessful save instead of claiming it
// disabled pauses. The content script observes the same keys via onChanged.
export async function loadLearnerSettings(): Promise<LearnerSettings> {
  return readSettings((await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}
export async function saveLearnerSettings(settings: LearnerSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: SettingsSchema.parse(settings) });
}
export async function loadActiveAccount(): Promise<string> {
  return readAccount((await browser.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY]);
}
export async function setActiveAccount(accountId: string): Promise<void> {
  if (readAccount(accountId) !== accountId) throw new Error('Choose a local test account.');
  await browser.storage.local.set({ [ACCOUNT_KEY]: accountId });
}
