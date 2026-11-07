import { z } from 'zod';
import {
  ApiErrorSchema, PracticeResponseSchema, SubmissionResponseSchema, WorkerMessageSchema,
  type ApiError, type PracticeResponse, type SubmissionResponse, type WorkerMessage, type WorkerReply,
} from './contracts';

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

export async function requestApi(raw: unknown, base: string, fetcher: typeof fetch = fetch): Promise<WorkerReply<PracticeResponse | SubmissionResponse>> {
  const parsed = WorkerMessageSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: apiError('INVALID_CODE', 'Invalid lookup or grading request.', false) };
  const message = parsed.data;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), message.type === 'lookup' ? 3000 : 15000);
  try {
    const origin = apiOrigin(base);
    const { type, ...body } = message;
    const response = await fetcher(message.type === 'lookup'
      ? `${origin}/v1/videos/${encodeURIComponent(message.videoId)}/practice`
      : `${origin}/v1/submissions`, {
      method: type === 'lookup' ? 'GET' : 'POST',
      ...(type === 'grade' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
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
    const result = (message.type === 'lookup' ? PracticeResponseSchema : SubmissionResponseSchema).safeParse(json);
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
      sendWhenReady(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), message.type === 'lookup' ? 3500 : 15500); }),
    ]);
    const parsed = z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), data: schema }), z.object({ ok: z.literal(false), error: ApiErrorSchema }),
    ]).safeParse(reply);
    return parsed.success ? parsed.data : { ok: false, error: apiError('INVALID_RESPONSE', 'The extension received an invalid response.') };
  } catch (error) {
    return { ok: false, error: apiError(error instanceof Error && error.message === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK', 'The request failed. Try again or skip and watch.') };
  } finally { clearTimeout(timer); }
}
