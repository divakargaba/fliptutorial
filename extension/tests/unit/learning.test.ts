import { describe, it, expect } from 'vitest';
import { attemptScope, completedAttempts, recordAttempt, saveSolution, listSolutions, deleteSolution, solutionUrl, type SolutionInput } from '../../src/learning/local';
function memory() { const data: Record<string, unknown> = {}; return { data, async get(key: string | null) { return key === null ? { ...data } : { [key]: data[key] }; }, async set(items: Record<string, unknown>) { Object.assign(data, items); }, async remove(keys: string | string[]) { for (const key of [keys].flat()) delete data[key]; } }; }
const entry: SolutionInput = { accountId: 'ana', videoId: 'samplevid01', exerciseId: 'ex', revision: 'r1', title: 'Power', videoTitle: 'Python tutorial', timestampS: 75, language: 'python', concepts: ['functions'], code: 'return x ** n', attempts: 2, hints: 1 };
describe('private local learning records', () => {
  it('counts distinct completed code hashes and scopes unlock to learner/exercise/revision', async () => {
    const store = memory(); const scope = attemptScope('ana', 'v', 'ex', 'r1');
    expect(await recordAttempt(scope, 'return 1', store)).toBe(1);
    expect(await recordAttempt(scope, ' return 1 ', store)).toBe(1);
    expect(await recordAttempt(scope, 'return 2', store)).toBe(2);
    expect(await recordAttempt(scope, 'return 99', store)).toBe(2);
    expect(await completedAttempts(scope, store, 1)).toBe(0);
    expect(await recordAttempt(scope, 'return 1', store, 1)).toBe(0);
    expect(await recordAttempt(scope, 'return 99', store, 1)).toBe(0);
    expect(await recordAttempt(scope, 'return 3', store, 1)).toBe(1);
    expect(await recordAttempt(scope, 'return 3', store, 1)).toBe(1);
    expect(await recordAttempt(scope, 'return 4', store, 1)).toBe(2);
    expect(await completedAttempts(scope, store, 2)).toBe(0);
    expect(await recordAttempt(scope, 'return 4', store, 2)).toBe(0);
    expect(await completedAttempts(attemptScope('bob', 'v', 'ex', 'r1'), store)).toBe(0);
    expect(await completedAttempts(attemptScope('ana', 'v', 'ex', 'r2'), store)).toBe(0);
    expect(JSON.stringify(store.data)).not.toContain('return');
  });
  it('saves immutable code snapshots, deduplicates review and isolates export/deletion from drafts and XP', async () => {
    const store = memory(); store.data['breakpoint:draft:untouched'] = 'editing'; store.data['breakpoint:event:xp'] = { id: 'xp' };
    await saveSolution(entry, store); const [saved] = await listSolutions('ana', store);
    await saveSolution({ ...entry, hints: 3 }, store);
    expect(await listSolutions('ana', store)).toEqual([saved]);
    await saveSolution({ ...entry, accountId: 'bob' }, store);
    expect((await listSolutions('bob', store))).toHaveLength(1);
    expect(solutionUrl(saved!, true)).toContain('bp_account=ana');
    expect(new URL(solutionUrl(saved!, true)).searchParams.has('bp_account')).toBe(false);
    expect(new URL(solutionUrl(saved!, true)).hash).toContain('bp_account=ana');
    await deleteSolution('ana', saved!.id, store);
    expect(await listSolutions('ana', store)).toEqual([]);
    expect(await listSolutions('bob', store)).toHaveLength(1);
    expect(store.data['breakpoint:draft:untouched']).toBe('editing');
    expect(store.data['breakpoint:event:xp']).toEqual({ id: 'xp' });
  });
  it('rejects malformed history and reports storage failures without network calls', async () => {
    const store = memory(); store.data['breakpoint:history:ana/bad'] = { code: 'secret', accountId: 'bob' };
    expect(await listSolutions('ana', store)).toEqual([]);
    store.set = async () => { throw new Error('quota'); };
    await expect(saveSolution(entry, store)).rejects.toThrow('quota');
  });
});
