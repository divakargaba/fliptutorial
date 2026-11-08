/** Small media boundary for marker navigation. It is independent of YouTube's
 * DOM and B2's visuals so cancellation/seek races can be tested deterministically. */
export type TimelineMedia = EventTarget & {
  currentTime: number;
  readonly seeking: boolean;
  readonly paused: boolean;
  pause(): void;
};

export function seekForPractice(media: TimelineMedia, time: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || !Number.isFinite(time) || time < 0) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const name of ['seeked', 'timeupdate']) media.removeEventListener(name, ready);
      for (const name of ['play', 'emptied', 'error']) media.removeEventListener(name, cancel);
      signal.removeEventListener('abort', cancel);
      resolve(ok);
    };
    const cancel = () => finish(false);
    const ready = () => {
      if (!media.seeking) finish(media.paused && Math.abs(media.currentTime - time) < 0.25);
    };
    // Subscribe before setting currentTime: cached and test media can complete
    // synchronously. Native play or a new source always wins over this request.
    for (const name of ['seeked', 'timeupdate']) media.addEventListener(name, ready);
    for (const name of ['play', 'emptied', 'error']) media.addEventListener(name, cancel);
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(cancel, 5000);
    try {
      media.pause();
      if (Math.abs(media.currentTime - time) < 0.05 && !media.seeking) ready();
      else media.currentTime = time;
    } catch { cancel(); }
  });
}
