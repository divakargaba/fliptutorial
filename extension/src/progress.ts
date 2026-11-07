import { browser } from 'wxt/browser';

const namespace = 'breakpoint:solved:';
const videoPrefix = (videoId: string) => `${namespace}${encodeURIComponent(videoId)}/`;
const solvedKey = (videoId: string, exerciseId: string, revision: string) =>
  `${videoPrefix(videoId)}${encodeURIComponent(exerciseId)}/${encodeURIComponent(revision)}`;

export async function markSolved(videoId: string, exerciseId: string, revision: string): Promise<void> {
  // One storage entry per exercise keeps concurrent submissions independent.
  await browser.storage.local.set({ [solvedKey(videoId, exerciseId, revision)]: true });
}

export async function getSolved(videoId: string, exerciseId: string, revision: string): Promise<boolean> {
  const key = solvedKey(videoId, exerciseId, revision);
  return (await browser.storage.local.get(key))[key] === true;
}

export async function listSolved(videoId: string, revision: string): Promise<Set<string>> {
  const prefix = videoPrefix(videoId);
  const encodedRevision = encodeURIComponent(revision);
  const solvedIds = new Set<string>();
  for (const [key, value] of Object.entries(await browser.storage.local.get(null))) {
    if (value !== true || !key.startsWith(prefix)) continue;
    const [exerciseId, savedRevision, extra] = key.slice(prefix.length).split('/');
    if (exerciseId && savedRevision === encodedRevision && extra === undefined) {
      solvedIds.add(decodeURIComponent(exerciseId));
    }
  }
  return solvedIds;
}
