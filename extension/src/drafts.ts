// Serialize writes per exercise so a slow storage call cannot overwrite a newer draft.
type LocalStorage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, string>): Promise<void>;
};
const pending = new Map<string, { code: string; timer: ReturnType<typeof setTimeout> }>();
const writing = new Map<string, Promise<void>>();
const storageKey = (key: string) => `breakpoint:draft:${key}`;
function storage(): LocalStorage {
  const api = (globalThis as typeof globalThis & {
    chrome?: { storage?: { local?: LocalStorage } };
  }).chrome?.storage?.local;
  if (!api) throw new Error('Local draft storage is unavailable.');
  return api;
}

export async function loadDraft(key: string): Promise<string | null> {
  const queued = pending.get(key);
  if (queued) return queued.code;
  await writing.get(key);
  const values = await storage().get(storageKey(key));
  const latest = pending.get(key);
  if (latest) return latest.code;
  const value = values[storageKey(key)];
  return typeof value === 'string' ? value : null;
}

export function saveDraft(key: string, code: string): void {
  const previous = pending.get(key);
  if (previous) clearTimeout(previous.timer);
  pending.set(key, {
    code,
    timer: setTimeout(() => { void flushDraft(key).catch(() => {}); }, 350),
  });
}

export async function flushDraft(key: string): Promise<void> {
  const queued = pending.get(key);
  if (!queued) { await writing.get(key); return; }
  clearTimeout(queued.timer);
  pending.delete(key);
  const operation = (writing.get(key) ?? Promise.resolve()).catch(() => {}).then(
    () => storage().set({ [storageKey(key)]: queued.code }),
  );
  writing.set(key, operation);
  try { await operation; }
  catch (error) {
    // Keep the failed write available to retry on close, without replacing newer edits.
    if (!pending.has(key) && writing.get(key) === operation) {
      pending.set(key, { code: queued.code, timer: setTimeout(() => {}, 0) });
    }
    throw error;
  } finally {
    if (writing.get(key) === operation) writing.delete(key);
  }
}
