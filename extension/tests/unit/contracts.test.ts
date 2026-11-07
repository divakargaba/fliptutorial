import { afterEach, describe, expect, it, vi } from 'vitest';
import practice from '../../../contracts/practice-response.fixture.json';
import grade from '../../../contracts/submission-response.fixture.json';
import { isContentSender, requestApi, sendRequest } from '../../src/api';
import { ApiErrorSchema, PracticeResponseSchema, SubmissionResponseSchema } from '../../src/contracts';

const base = 'http://127.0.0.1:8000';
const lookup = { type: 'lookup', videoId: practice.videoId } as const;
const apiFailure = { error: { code: 'BUSY', message: 'Retry shortly.', retryable: true }, requestId: 'test' };

afterEach(() => vi.useRealTimers());

describe('shared fixtures', () => {
  it('validates the published ready, unsupported, grade, and error shapes', () => {
    expect(PracticeResponseSchema.parse(practice)).toEqual(practice);
    expect(PracticeResponseSchema.parse({ ...practice, revision: null, status: 'unsupported', breakpoints: [] }).status).toBe('unsupported');
    expect(SubmissionResponseSchema.parse(grade)).toEqual(grade);
    expect(ApiErrorSchema.parse(apiFailure)).toEqual(apiFailure);
  });

  it('rejects unsafe times, duplicate entries, hidden data, and inconsistent verdicts', () => {
    const point = practice.breakpoints[0]!;
    expect(PracticeResponseSchema.safeParse({ ...practice, breakpoints: [{ ...point, pauseAtS: point.revealAtS }] }).success).toBe(false);
    expect(PracticeResponseSchema.safeParse({ ...practice, breakpoints: [point, point] }).success).toBe(false);
    expect(SubmissionResponseSchema.safeParse({ ...grade, results: [{ kind: 'hidden', index: 0, passed: false, actual: 4 }] }).success).toBe(false);
    expect(SubmissionResponseSchema.safeParse({ ...grade, outcome: 'passed' }).success).toBe(false);
  });
});

describe('extension API boundary', () => {
  it('accepts only same-extension top-frame YouTube senders', () => {
    const sender = { id: 'ext', frameId: 0, tab: { id: 1 }, url: 'https://www.youtube.com/watch?v=samplevid01' };
    expect(isContentSender(sender, 'ext')).toBe(true);
    expect(isContentSender({ ...sender, frameId: 1 }, 'ext')).toBe(false);
    expect(isContentSender({ ...sender, url: 'https://www.youtube.com.example.com/watch' }, 'ext')).toBe(false);
    expect(isContentSender(sender, 'different')).toBe(false);
  });

  it('builds the endpoint and forwards a validated reply', async () => {
    const fetcher = vi.fn(async () => Response.json(practice));
    expect(await requestApi(lookup, base, fetcher)).toEqual({ ok: true, data: practice });
    expect(fetcher).toHaveBeenCalledWith(`${base}/v1/videos/samplevid01/practice`, expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(await sendRequest(lookup, PracticeResponseSchema, async () => ({ ok: true, data: practice }))).toEqual({ ok: true, data: practice });
  });

  it('sends only agreed grading fields and preserves structured API errors', async () => {
    const fetcher = vi.fn(async () => Response.json(apiFailure, { status: 429 }));
    const payload = { exerciseId: 'exponent', revision: 'r1', mode: 'submit', code: 'return 8' };
    expect(await requestApi({ ...payload, type: 'grade' }, base, fetcher)).toEqual({ ok: false, error: apiFailure });
    expect(fetcher).toHaveBeenCalledWith(`${base}/v1/submissions`, expect.objectContaining({ method: 'POST', body: JSON.stringify(payload) }));
  });

  it('rejects a message-supplied URL, non-loopback backend, and mismatched video', async () => {
    const fetcher = vi.fn(async () => Response.json({ ...practice, videoId: 'otherVideo1' }));
    expect((await requestApi({ ...lookup, url: 'https://example.com' }, base, fetcher)).ok).toBe(false);
    expect((await requestApi(lookup, 'https://example.com', fetcher)).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await requestApi(lookup, base, fetcher)).toMatchObject({ ok: false, error: { error: { code: 'INVALID_RESPONSE' } } });
  });

  it('bounds lookup time and reports cancellation as a timeout', async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = (_input, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const result = requestApi(lookup, base, fetcher);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toMatchObject({ ok: false, error: { error: { code: 'TIMEOUT', retryable: true } } });
  });
});
