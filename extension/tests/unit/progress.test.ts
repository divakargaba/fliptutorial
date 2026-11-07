import { beforeEach, expect, it, vi } from 'vitest';
import { getSolved, listSolved, markSolved } from '../../src/progress';

let stored: Record<string, unknown>;
vi.mock('wxt/browser', () => ({ browser: { storage: { local: {
    get: async (key: string | null) => key === null ? { ...stored } : { [key]: stored[key] },
    set: async (values: Record<string, unknown>) => { Object.assign(stored, values); },
} } } }));
beforeEach(() => { stored = {}; });

it('stores only solved exercises and isolates videos and revisions', async () => {
  stored['breakpoint:draft:demo/video/r1'] = 'pass';
  expect(await getSolved('demo', 'first', 'r1')).toBe(false);
  await markSolved('demo', 'first', 'r1');
  await markSolved('demo', 'later', 'r2');
  await markSolved('different', 'first', 'r1');
  expect(await getSolved('demo', 'first', 'r1')).toBe(true);
  expect(await getSolved('demo', 'first', 'r2')).toBe(false);
  expect(await listSolved('demo', 'r1')).toEqual(new Set(['first']));
  expect(await listSolved('demo', 'r2')).toEqual(new Set(['later']));
});

it('keeps simultaneous solves and handles separators in IDs', async () => {
  await Promise.all([
    markSolved('demo', 'exercise/one', 'r/1'),
    markSolved('demo', 'exercise%two', 'r/1'),
    markSolved('demo', 'exercise/one', 'r/1'),
  ]);
  expect(Object.keys(stored)).toHaveLength(2);
  expect(await listSolved('demo', 'r/1')).toEqual(new Set(['exercise/one', 'exercise%two']));
});
