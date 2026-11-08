import { browser } from 'wxt/browser';
import { isContentSender, requestApi } from '../src/api';
import { requestPlanApi } from '../src/plan/api';
import { EventQueue } from '../src/plan/events';
import { PlanMessageSchema } from '../src/plan/schemas';
import { z } from 'zod';

export default defineBackground(() => {
  const base = import.meta.env.WXT_API_BASE_URL || 'http://127.0.0.1:8000';
  const events = new EventQueue(browser.storage.local, async batch => {
    const reply = await requestPlanApi({ type: 'eventsV2', events: batch }, base);
    const ack = reply.ok ? z.object({ acknowledgedIds: z.array(z.string()) }).safeParse(reply.data) : null;
    return ack?.success ? ack.data.acknowledgedIds : false;
  });
  // Restart-safe: stored events are retried on every worker wake and subsequent
  // content heartbeat. Rejected delivery never removes them from local storage.
  void events.flush().catch(() => {});
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isContentSender(sender, browser.runtime.id)) return false;
    const v2 = PlanMessageSchema.safeParse(message);
    if (v2.success && v2.data.type === 'eventsV2') {
      void events.enqueue(v2.data.events).then(() => {
        sendResponse({ ok: true, data: null });
        void events.flush().catch(() => {});
      }).catch(() => sendResponse({ ok: false, error: { error: { code: 'STORAGE', message: 'Could not save practice progress.', retryable: true }, requestId: 'local' } }));
    } else if (message?.type === 'flushEventsV2') {
      void events.flush().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    } else {
      void (v2.success ? requestPlanApi(v2.data, base) : requestApi(message, base)).then(sendResponse);
    }
    return true;
  });
});
