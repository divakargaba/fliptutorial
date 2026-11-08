import { z } from 'zod';

// Browser-local presentation records. Never included in practice-event payloads.
const solutionSchema = z.object({
  id: z.string(), accountId: z.string(), videoId: z.string().regex(/^[\w-]{11}$/),
  exerciseId: z.string(), revision: z.string(), title: z.string().max(300), videoTitle: z.string().max(300),
  timestampS: z.number().nonnegative(), language: z.string(), concepts: z.array(z.string()).max(30),
  code: z.string().max(16384), savedAt: z.string(), attempts: z.number().int().nonnegative(), hints: z.number().int().min(0).max(3),
});
export type SavedSolution = z.infer<typeof solutionSchema>;
export type SolutionInput = Omit<SavedSolution, 'id' | 'savedAt'>;
type Store = { get(keys: null | string): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void>; remove(keys: string | string[]): Promise<void> };
function storage(): Store {
  const api = (globalThis as typeof globalThis & { chrome?: { storage?: { local?: Store } } }).chrome?.storage?.local;
  if (!api) throw new Error('Local storage is unavailable.');
  return api;
}
const encode = encodeURIComponent;
export const attemptScope = (account: string, video: string, exercise: string, revision: string) => [account, video, exercise, revision].map(encode).join('/');
const attemptPrefix = (scope: string, stage = 0) => `breakpoint:effort:${scope}/${stage ? `hint-${stage}/` : ''}`;
const historyPrefix = (account: string) => `breakpoint:history:${encode(account)}/`;
export async function codeFingerprint(code: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.trim()));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function completedAttempts(scope: string, store = storage(), stage = 0): Promise<number> {
  const all = await store.get(null);
  const prefix = attemptPrefix(scope, stage);
  return Math.min(2, Object.keys(all).filter(key => key.startsWith(prefix) && /^[a-f0-9]{64}$/.test(key.slice(prefix.length)) && all[key] === true).length);
}
export async function recordAttempt(scope: string, code: string, store = storage(), stage = 0): Promise<number> {
  // Independent hash keys preserve concurrent-tab writes without storing failed code.
  const count = await completedAttempts(scope, store, stage);
  const hash = await codeFingerprint(code);
  const all = await store.get(null);
  // Replaying code from an earlier hint stage cannot unlock the next hint.
  if (Object.keys(all).some(key => key.startsWith(attemptPrefix(scope)) && key.endsWith(`/${hash}`) && all[key] === true)) return count;
  await store.set({ [attemptPrefix(scope, stage) + hash]: true });
  return completedAttempts(scope, store, stage);
}
export async function listSolutions(account: string, store = storage()): Promise<SavedSolution[]> {
  const all = await store.get(null);
  return Object.entries(all).filter(([key]) => key.startsWith(historyPrefix(account))).flatMap(([key, value]) => {
    const parsed = solutionSchema.safeParse(value);
    return parsed.success && parsed.data.accountId === account && key === historyPrefix(account) + parsed.data.id ? [parsed.data] : [];
  }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
export async function saveSolution(input: SolutionInput, store = storage()): Promise<void> {
  const id = await codeFingerprint([input.videoId, input.exerciseId, input.revision, input.code].join('\n'));
  const key = historyPrefix(input.accountId) + id;
  if ((await store.get(key))[key]) return; // Reviewing the same solution is not a new history entry.
  const entry = solutionSchema.parse({ ...input, id, savedAt: new Date().toISOString() });
  if (new TextEncoder().encode(entry.code).length > 16384) throw new Error('Solution too large.');
  await store.set({ [key]: entry });
  const saved = await listSolutions(input.accountId, store);
  // Bounded local history. Do not touch another learner's records or any drafts.
  if (saved.length > 200) await store.remove(saved.slice(200).map(row => historyPrefix(input.accountId) + row.id));
}
export async function deleteSolution(account: string, id: string, store = storage()) {
  await store.remove(historyPrefix(account) + id);
}
export function solutionUrl(row: SavedSolution, practice = false) {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', row.videoId); url.searchParams.set('t', String(Math.floor(row.timestampS)));
  if (practice) url.hash = new URLSearchParams({ bp_review: row.exerciseId, bp_revision: row.revision, bp_account: row.accountId }).toString();
  return url.href;
}
