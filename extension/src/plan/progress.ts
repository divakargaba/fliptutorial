import { browser } from 'wxt/browser';

// v2 completions belong to the local account as well as the exercise revision.
// Legacy prepared-video keys remain unchanged for the existing demo.
const key = (account: string, video: string, exercise: string, revision: string) =>
  'breakpoint:plan-solved:' + [account, video, exercise, revision].map(encodeURIComponent).join('/');
export async function planSolved(account: string, video: string, exercise: string, revision: string): Promise<boolean> {
  const name = key(account, video, exercise, revision);
  return (await browser.storage.local.get(name))[name] === true;
}
export async function markPlanSolved(account: string, video: string, exercise: string, revision: string): Promise<void> {
  await browser.storage.local.set({ [key(account, video, exercise, revision)]: true });
}
