export type WatchSample = { time: number; wallMs: number; rate: number; playing: boolean; seeking: boolean; ad: boolean; ready: boolean };

/** Records observed media intervals, never infers watching from the playhead's
 * final position. Missing callbacks deliberately undercount instead of turning
 * sleep, buffering, seeks or route changes into hours of fictional progress. */
export class WatchSegments {
  private previous: WatchSample | null = null;
  private segment: [number, number] | null = null;
  constructor(private emit: (segment: [number, number]) => void) {}

  sample(next: WatchSample): void {
    const previous = this.previous;
    const valid = next.playing && !next.seeking && !next.ad && next.ready &&
      Number.isFinite(next.time) && next.time >= 0 && Number.isFinite(next.wallMs) && Number.isFinite(next.rate) && next.rate > 0;
    if (!valid) { this.flush(); this.previous = null; return; }
    this.previous = next;
    if (!previous) return;
    const elapsed = (next.wallMs - previous.wallMs) / 1000;
    const delta = next.time - previous.time;
    if (elapsed <= 0 || elapsed > 2 || delta <= 0 || delta > elapsed * Math.max(next.rate, previous.rate) + 0.25) {
      this.flush(); return;
    }
    if (!this.segment) this.segment = [previous.time, next.time];
    else this.segment[1] = next.time;
    // Small batches survive navigation without producing a write per frame.
    if (this.segment[1] - this.segment[0] >= 15) this.flush();
  }

  reset(): void { this.flush(); this.previous = null; }
  private flush(): void {
    const segment = this.segment;
    this.segment = null;
    if (segment && segment[1] > segment[0]) this.emit(segment);
  }
}
