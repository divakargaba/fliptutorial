import type { PracticeEvent } from '../v2/types';
import { PracticeEventSchema } from './schemas';

export type EventStorage = {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};
const prefix = 'breakpoint:event:';

/** One durable entry per immutable event avoids cross-tab read/modify/write
 * races. A worker crash after delivery may resend IDs; the backend's idempotent
 * /v2/events contract makes that safe. Never delete a batch before its ACK. */
export class EventQueue {
  private flushing: Promise<void> | null = null;
  constructor(private storage: EventStorage, private deliver: (events: PracticeEvent[]) => Promise<boolean | readonly string[]>) {}

  async enqueue(events: PracticeEvent[]): Promise<void> {
    const parsed = events.map(event => PracticeEventSchema.parse(event));
    await this.storage.set(Object.fromEntries(parsed.map(e => [prefix + e.id, e])));
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    // Bound each worker wake; the content heartbeat retries while the browser
    // is in use. There is no timer that assumes an MV3 worker stays alive.
    const records = await this.storage.get(null);
    const valid = Object.entries(records).filter(([key]) => key.startsWith(prefix)).flatMap(([key, raw]) => {
      const event = PracticeEventSchema.safeParse(raw);
      return event.success && key === prefix + event.data.id ? [{ key, event: event.data }] : [];
    }).sort((a, b) => a.event.at.localeCompare(b.event.at));
    for (let offset = 0; offset < Math.min(valid.length, 500); offset += 100) {
      const batch = valid.slice(offset, offset + 100);
      const acknowledged = await this.deliver(batch.map(row => row.event));
      if (acknowledged === false) return;
      const ids = acknowledged === true ? new Set(batch.map(row => row.event.id)) : new Set(acknowledged);
      await this.storage.remove(batch.filter(row => ids.has(row.event.id)).map(row => row.key));
      // A 200 may contain per-event rejections. Keep those records for diagnosis
      // and retry; the successful neighbours must not be uploaded repeatedly.
      if (batch.some(row => !ids.has(row.event.id))) return;
    }
  }
}
