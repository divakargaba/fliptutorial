import { z } from 'zod';
import {
  AnalysisResponseSchema, ApiErrorSchema, HintResponseSchema, PracticeResponseSchema, SubmissionResponseSchema,
  TestMeResponseSchema, WorkerMessageSchema, type AnalysisResponse, type ApiError, type HintResponse,
  type PracticeResponse, type SubmissionResponse, type TestMeResponse, type WorkerMessage, type WorkerReply,
} from './contracts';

const requests = {
  lookup: { timeoutMs: 3000, schema: PracticeResponseSchema },
  grade: { timeoutMs: 15000, schema: SubmissionResponseSchema, path: '/v1/submissions' },
  testMe: { timeoutMs: 20000, schema: TestMeResponseSchema, path: '/v1/test-me' },
  hint: { timeoutMs: 18000, schema: HintResponseSchema, path: '/v1/hints' },
  analyze: { timeoutMs: 15000, schema: AnalysisResponseSchema, path: '/v1/analysis' },
};

export function apiError(code: string, message: string, retryable = true): ApiError {
  return { error: { code, message, retryable }, requestId: crypto.randomUUID() };
}

export function isContentSender(sender: { id?: string; url?: string; frameId?: number; tab?: { id?: number } }, extensionId: string): boolean {
  if (sender.id !== extensionId || sender.frameId !== 0 || sender.tab?.id === undefined || !sender.url) return false;
  try { return new URL(sender.url).origin === 'https://www.youtube.com'; } catch { return false; }
}

// Only the configured loopback API is reachable. Messages never contain URLs or headers.
export function apiOrigin(base: string): string {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Use a loopback API origin');
  return url.origin;
}

export async function requestApi(raw: unknown, base: string, fetcher: typeof fetch = fetch): Promise<WorkerReply<PracticeResponse | SubmissionResponse | TestMeResponse | HintResponse | AnalysisResponse>> {
  const parsed = WorkerMessageSchema.safeParse(raw);
  if (!parsed.success) {
    const testMe = typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'testMe';
    return { ok: false, error: testMe
      ? apiError('INVALID_REQUEST', 'Invalid Test me request.', false)
      : apiError('INVALID_CODE', 'Invalid lookup or grading request.', false) };
  }
  const message = parsed.data;
  const request = requests[message.type];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const origin = apiOrigin(base);
    const { type, ...body } = message;
    const path = message.type === 'lookup'
      ? `/v1/videos/${encodeURIComponent(message.videoId)}/practice`
      : requests[message.type].path;
    const response = await fetcher(`${origin}${path}`, {
      method: type === 'lookup' ? 'GET' : 'POST',
      ...(type === 'lookup' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
    });
    let json: unknown;
    try { json = await response.json(); } catch (error) {
      if (controller.signal.aborted) throw error;
      return { ok: false, error: apiError('INVALID_RESPONSE', 'The local API returned unreadable data.') };
    }
    if (!response.ok) {
      const failure = ApiErrorSchema.safeParse(json);
      return { ok: false, error: failure.success ? failure.data : apiError('INVALID_RESPONSE', 'The local API returned an invalid error.') };
    }
    const result = request.schema.safeParse(json);
    if (!result.success || (message.type === 'lookup' && 'videoId' in result.data && result.data.videoId !== message.videoId)) {
      return { ok: false, error: apiError('INVALID_RESPONSE', 'The local API returned an invalid response.') };
    }
    return { ok: true, data: result.data };
  } catch {
    return { ok: false, error: controller.signal.aborted
      ? apiError('TIMEOUT', 'The request timed out. Try again or skip and watch.')
      : apiError('NETWORK', 'Cannot reach the local API. Start the backend and try again.') };
  } finally { clearTimeout(timeout); }
}

export async function sendRequest<T>(message: WorkerMessage, schema: z.ZodType<T>, send: (message: WorkerMessage) => Promise<unknown>): Promise<WorkerReply<T>> {
  // Also bound the content-side wait if the worker is restarted while handling a message.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = requests[message.type].timeoutMs + (message.type === 'testMe' ? 0 : 500);
  const sendWhenReady = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await send(message); }
      catch (error) {
        // Early lookups can race a cold MV3 listener. Only retry this idempotent
        // read, at most twice, within the original content-side deadline.
        if (message.type !== 'lookup' || attempt >= 2 || !(error instanceof Error) ||
            !error.message.includes('Receiving end does not exist')) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 100 : 300));
      }
    }
  };
  try {
    const reply = await Promise.race([
      sendWhenReady(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs); }),
    ]);
    const parsed = z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), data: schema }), z.object({ ok: z.literal(false), error: ApiErrorSchema }),
    ]).safeParse(reply);
    return parsed.success ? parsed.data : { ok: false, error: apiError('INVALID_RESPONSE', 'The extension received an invalid response.') };
  } catch (error) {
    return { ok: false, error: apiError(error instanceof Error && error.message === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK', 'The request failed. Try again or skip and watch.') };
  } finally { clearTimeout(timer); }
}
