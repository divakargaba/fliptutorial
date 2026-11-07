import { expect, test } from '@playwright/test';
import { flushDraft, loadDraft, saveDraft } from '../../src/drafts';

test('draft writes serialize and keep the latest pending edit', async () => {
  const saved: Record<string, string> = {};
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  Object.assign(globalThis, { chrome: { storage: { local: {
    async get(key: string) { return { [key]: saved[key] }; },
    async set(values: Record<string, string>) {
      if (Object.values(values)[0] === 'old') { started(); await waiting; }
      Object.assign(saved, values);
    },
  } } } });
  const key = 'video/exercise/serialized';
  saveDraft(key, 'old');
  const first = flushDraft(key);
  await firstStarted;
  saveDraft(key, 'new');
  expect(await loadDraft(key)).toBe('new');
  const second = flushDraft(key);
  release();
  await Promise.all([first, second]);
  expect(await loadDraft(key)).toBe('new');
});

test('failed writes remain recoverable and revision keys stay separate', async () => {
  const saved: Record<string, string> = {};
  let fail = true;
  Object.assign(globalThis, { chrome: { storage: { local: {
    async get(key: string) { return { [key]: saved[key] }; },
    async set(values: Record<string, string>) {
      if (fail) throw new Error('Storage temporarily unavailable');
      Object.assign(saved, values);
    },
  } } } });
  const key = 'video/exercise/retry';
  saveDraft(key, '');
  await expect(flushDraft(key)).rejects.toThrow('Storage temporarily unavailable');
  expect(await loadDraft(key)).toBe('');
  fail = false;
  await flushDraft(key);
  expect(await loadDraft(key)).toBe('');
  expect(await loadDraft('video/exercise/new-revision')).toBeNull();
});

test('an older failed write cannot resurrect a draft after a newer flush', async () => {
  const saved: Record<string, string> = {};
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  Object.assign(globalThis, { chrome: { storage: { local: {
    async get(key: string) { return { [key]: saved[key] }; },
    async set(values: Record<string, string>) {
      if (Object.values(values)[0] === 'old') { started(); await waiting; throw new Error('Old write failed'); }
      Object.assign(saved, values);
    },
  } } } });
  const key = 'video/exercise/stale-retry';
  saveDraft(key, 'old');
  const first = flushDraft(key).catch(() => {});
  await firstStarted;
  saveDraft(key, 'new');
  const second = flushDraft(key);
  release();
  await Promise.all([first, second]);
  await flushDraft(key);
  expect(await loadDraft(key)).toBe('new');
});
