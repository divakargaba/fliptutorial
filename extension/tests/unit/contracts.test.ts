import { afterEach, describe, expect, it, vi } from 'vitest';
import practice from '../../../contracts/practice-response.fixture.json';
import grade from '../../../contracts/submission-response.fixture.json';
import testMe from '../../../contracts/testme-response.fixture.json';
import hintFixture from '../../../contracts/hint-response.fixture.json';
import analysisFixture from '../../../contracts/analysis-response.fixture.json';
import { isContentSender, requestApi, sendRequest } from '../../src/api';
import { AnalysisResponseSchema, ApiErrorSchema, HintResponseSchema, PracticeResponseSchema, SubmissionResponseSchema, TestMeResponseSchema, WorkerMessageSchema } from '../../src/contracts';

const base = 'http://127.0.0.1:8000';
const lookup = { type: 'lookup', videoId: practice.videoId } as const;
const testMeMessage = { type: 'testMe', videoId: practice.videoId, timestampS: 234.5 } as const;
const apiFailure = { error: { code: 'BUSY', message: 'Retry shortly.', retryable: true }, requestId: 'test' };

afterEach(() => vi.useRealTimers());

describe('shared fixtures', () => {
  it('validates the published ready, unsupported, grade, Test me, and error shapes', () => {
    expect(PracticeResponseSchema.parse(practice)).toEqual(practice);
    expect(PracticeResponseSchema.parse({ ...practice, revision: null, status: 'unsupported', breakpoints: [] }).status).toBe('unsupported');
    expect(SubmissionResponseSchema.parse(grade)).toEqual(grade);
    expect(TestMeResponseSchema.parse(testMe)).toEqual(testMe);
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

  it('posts the video and timestamp and forwards the generated exercise', async () => {
    const fetcher = vi.fn(async () => Response.json(testMe));
    expect(await requestApi(testMeMessage, base, fetcher)).toEqual({ ok: true, data: testMe });
    expect(fetcher).toHaveBeenCalledWith(`${base}/v1/test-me`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ videoId: testMeMessage.videoId, timestampS: testMeMessage.timestampS }),
      credentials: 'omit',
      redirect: 'error',
    }));
    expect(await sendRequest(testMeMessage, TestMeResponseSchema, async () => ({ ok: true, data: testMe })))
      .toEqual({ ok: true, data: testMe });
  });

  it('rejects unsafe Test me messages and responses', async () => {
    const fetcher = vi.fn(async () => Response.json({ ...testMe, exercise: { ...testMe.exercise, hiddenTests: [] } }));
    for (const timestampS of [-1, NaN, Infinity]) {
      expect(await requestApi({ ...testMeMessage, timestampS }, base, fetcher))
        .toMatchObject({ ok: false, error: { error: { code: 'INVALID_REQUEST', retryable: false } } });
    }
    expect((await requestApi({ ...testMeMessage, url: 'https://example.com' }, base, fetcher)).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await requestApi(testMeMessage, base, fetcher))
      .toMatchObject({ ok: false, error: { error: { code: 'INVALID_RESPONSE' } } });
    expect(TestMeResponseSchema.safeParse({ ...testMe, aiGenerated: false }).success).toBe(false);
  });

  it('preserves structured generation errors', async () => {
    const error = { error: { code: 'NO_CAPTIONS', message: 'No English captions found.', retryable: false }, requestId: 'test' };
    const fetcher = vi.fn(async () => Response.json(error, { status: 404 }));
    expect(await requestApi(testMeMessage, base, fetcher)).toEqual({ ok: false, error });
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

  it('bounds both Test me waits at 20 seconds', async () => {
    vi.useFakeTimers();
    const onAbort = vi.fn();
    const fetcher: typeof fetch = (_input, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => {
        onAbort();
        reject(new Error('aborted'));
      });
    });
    const workerReply = requestApi(testMeMessage, base, fetcher);
    const contentReply = sendRequest(testMeMessage, TestMeResponseSchema, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(onAbort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onAbort).toHaveBeenCalledOnce();
    const timeout = { ok: false, error: { error: { code: 'TIMEOUT', retryable: true } } };
    expect(await workerReply).toMatchObject(timeout);
    expect(await contentReply).toMatchObject(timeout);
  });
});

describe('hint and analysis contracts (H1/H2)', () => {
  it('lets a valid long hint advance by bounding history only in the outgoing request', async () => {
    const longHint = 'Think about how the accumulated value changes after each repetition. '.repeat(9);
    const received = HintResponseSchema.parse({ ...hintFixture, level: 1, hint: longHint });
    const message = { type: 'hint', exerciseId: 'exponent', revision: 'r1', code: 'pass',
      level: 2, previousHints: [received.hint!] } as const;
    const fetcher = vi.fn(async () => Response.json(hintFixture));

    expect(await requestApi(message, base, fetcher)).toEqual({ ok: true, data: hintFixture });
    expect(fetcher).toHaveBeenCalledWith(`${base}/v1/hints`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ exerciseId: 'exponent', revision: 'r1', code: 'pass',
        level: 2, previousHints: [longHint.slice(0, 400)] }),
    }));
    // Request normalization must not truncate the response the panel displays.
    expect(received.hint).toBe(longHint);
    expect(message.previousHints).toEqual([longHint]);
  });

  it('counts hint history like the backend without splitting Unicode characters', () => {
    const previous = 'a'.repeat(399) + '💡' + ' trailing context';
    const parsed = WorkerMessageSchema.parse({ type: 'hint', exerciseId: 'e', revision: 'r',
      code: 'pass', level: 2, previousHints: ['Short hint.', previous] });
    expect(parsed.type).toBe('hint');
    if (parsed.type !== 'hint') throw new Error('Expected hint request');
    expect(parsed.previousHints).toEqual(['Short hint.', 'a'.repeat(399) + '💡']);
  });

  it('still rejects invalid hint history before contacting the API', async () => {
    const fetcher = vi.fn(async () => Response.json(hintFixture));
    for (const previousHints of [['x', 42], Array(7).fill('x'), 'not an array']) {
      expect((await requestApi({ type: 'hint', exerciseId: 'e', revision: 'r', code: 'pass',
        level: 2, previousHints }, base, fetcher)).ok).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('parses the shared fixtures', () => {
    expect(HintResponseSchema.parse(hintFixture).level).toBe(2);
    expect(AnalysisResponseSchema.parse(analysisFixture).optimal).toBe(false);
  });
  it('rejects non-https doc links and out-of-range hint levels', () => {
    const base = { level: 1, maxLevel: 3, feedback: null, hint: 'x', focus: 'f', aiGenerated: true };
    expect(HintResponseSchema.safeParse({ ...base, sources: [{ title: 't', url: 'javascript:alert(1)' }] }).success).toBe(false);
    expect(WorkerMessageSchema.safeParse({ type: 'hint', exerciseId: 'e', revision: 'r', code: '', level: 4 }).success).toBe(false);
    expect(WorkerMessageSchema.safeParse({ type: 'hint', exerciseId: 'e', revision: 'r', code: 'x', level: 0,
      lastResult: { outcome: 'wrong_answer', args: [1], expected: 2, actual: 3 } }).success).toBe(true);
    expect(WorkerMessageSchema.safeParse({ type: 'analyze', exerciseId: 'e', revision: 'r', code: '' }).success).toBe(false);
  });
});
