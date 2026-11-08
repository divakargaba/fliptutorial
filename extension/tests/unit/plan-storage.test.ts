import { beforeEach, expect, it, vi } from 'vitest';
const { values, set } = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  return { values, set: vi.fn(async (entries: Record<string, unknown>) => { Object.assign(values, entries); }) };
});
vi.mock('wxt/browser', () => ({ browser: { storage: { local: {
  get: async (key: string) => ({ [key]: values[key] }), set,
} } } }));
import { loadActiveAccount, loadLearnerSettings, saveLearnerSettings, setActiveAccount } from '../../src/plan/preferences';
import { markPlanSolved, planSolved } from '../../src/plan/progress';
beforeEach(() => { for (const key of Object.keys(values)) delete values[key]; set.mockClear(); });

it('supplies defaults and shares valid settings/account writes with the popup', async () => {
  expect(await loadActiveAccount()).toBe('test-ana');
  const settings = { frequency: 'few' as const, autoPause: false, disabledVideos: ['samplevid01'] };
  await saveLearnerSettings(settings); expect(await loadLearnerSettings()).toEqual(settings);
  await setActiveAccount('test-ben'); expect(await loadActiveAccount()).toBe('test-ben');
  await expect(setActiveAccount('invalid')).rejects.toThrow();
});
it('isolates completion by account, video, exercise and revision', async () => {
  await markPlanSolved('test-ana', 'samplevid01', 'exercise', 'r1');
  expect(await planSolved('test-ana', 'samplevid01', 'exercise', 'r1')).toBe(true);
  expect(await planSolved('test-ben', 'samplevid01', 'exercise', 'r1')).toBe(false);
  expect(await planSolved('test-ana', 'samplevid01', 'exercise', 'r2')).toBe(false);
  expect(await planSolved('test-ana', 'other000001', 'exercise', 'r1')).toBe(false);
});
it('propagates save failures so settings never falsely promise to disable pauses', async () => {
  set.mockRejectedValueOnce(new Error('storage full'));
  await expect(saveLearnerSettings({ frequency: 'normal', autoPause: false, disabledVideos: [] })).rejects.toThrow('storage full');
});
