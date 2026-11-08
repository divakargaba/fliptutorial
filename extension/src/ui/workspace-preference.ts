// Presentation-only preference. Deliberately separate from frozen learner settings.
export const PRACTICE_LAYOUT_KEY = 'breakpoint:practice-layout';
export type PracticeLayout = 'side' | 'below';
export const readPracticeLayout = (value: unknown): PracticeLayout => value === 'side' ? 'side' : 'below';

export async function loadPracticeLayout(): Promise<PracticeLayout> {
  const { browser } = await import('wxt/browser');
  return readPracticeLayout((await browser.storage.local.get(PRACTICE_LAYOUT_KEY))[PRACTICE_LAYOUT_KEY]);
}
export async function savePracticeLayout(layout: PracticeLayout): Promise<void> {
  const { browser } = await import('wxt/browser');
  await browser.storage.local.set({ [PRACTICE_LAYOUT_KEY]: readPracticeLayout(layout) });
}
