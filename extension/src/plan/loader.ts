import type { ExercisePlan } from '../v2/types';
import type { WorkerReply } from '../contracts';

/** Each navigation owns a loader. Cancelling it makes every pending response
 * inert; planning never waits on or takes ownership of the YouTube player. */
export class PlanLoader {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polls = 0;
  constructor(private request: (poll: boolean) => Promise<WorkerReply<ExercisePlan>>,
    private accept: (plan: ExercisePlan) => void) {}
  start(): void { void this.load(false); }
  stop(): void { this.stopped = true; clearTimeout(this.timer); }
  private schedule(): void {
    if (this.stopped) return;
    const delay = Math.min(30000, 5000 * (1 + Math.floor(this.polls++ / 12)));
    this.timer = setTimeout(() => { void this.load(true); }, delay);
  }
  private async load(poll: boolean): Promise<void> {
    try {
      const reply = await this.request(poll);
      if (this.stopped) return;
      if (!reply.ok) {
        if (reply.error.error.retryable) this.schedule();
        return;
      }
      this.accept(reply.data);
      // Long lectures can legitimately take several minutes. Poll only while
      // this route lives, gradually backing off. The transport supplies an
      // idempotent read of the same video and learner map on every poll.
      if (!this.stopped && reply.data.status === 'planning') {
        this.schedule();
      }
    } catch { this.schedule(); /* A transient transport failure leaves playback untouched. */ }
  }
}
