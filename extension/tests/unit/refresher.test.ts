import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../contracts/v2/exercise-plan.fixture.json';
import { PlaybackSession } from '../../src/playback';
import { ExercisePlanSchema, RefresherSchema } from '../../src/plan/schemas';
import { requestPlanApi } from '../../src/plan/api';
import { defaultSettings } from '../../src/plan/settings';

const plan = ExercisePlanSchema.parse(fixture);
const question = plan.pauses.find(p => p.question)!.question!;
const pick = { accountId: 'test-ana', concept: question.concepts[0], conceptName: 'Loops',
  strength: 0.2, reason: 'Time to review', question };

describe('refresher boundary', () => {
  it('requests one selected skill and rejects a different skill response', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(pick));
    const request = { type: 'refresherV2' as const, accountId: 'test-ana', concept: pick.concept };
    expect((await requestPlanApi(request, 'http://127.0.0.1:8000', fetcher)).ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:8000/v2/refresher/test-ana?concept=${pick.concept}`);
    expect((await requestPlanApi({ ...request, concept: 'functions' }, 'http://127.0.0.1:8000', fetcher)).ok).toBe(false);
  });
  it('uses a bounded learner-specific GET and treats 204 as nothing due', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await requestPlanApi({ type: 'refresherV2', accountId: 'test-ana' }, 'http://127.0.0.1:8000', fetcher)).toEqual({ ok: true, data: null });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8000/v2/refresher/test-ana', expect.objectContaining({
      method: 'GET', credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal),
    }));
  });
  it('accepts the public question but rejects wrong-account and answer-bearing responses', async () => {
    const request = (data: unknown) => requestPlanApi({ type: 'refresherV2', accountId: 'test-ana' },
      'http://127.0.0.1:8000', async () => Response.json(data));
    expect(await request(pick)).toEqual({ ok: true, data: pick });
    expect((await request({ ...pick, accountId: 'test-ben' })).ok).toBe(false);
    expect((await request({ ...pick, question: { ...question, answer: 'secret' } })).ok).toBe(false);
    expect((await request(null)).ok).toBe(false);
    expect(RefresherSchema.safeParse({ ...pick, concept: 'unrelated' }).success).toBe(false);
  });
});

describe('deliberate refresher playback', () => {
  it('opens without a video plan and preserves native pause ownership', () => {
    const s = new PlaybackSession(); s.navigate(fixture.videoId);
    const ticket = s.startRefresher(question, 30, false)!;
    expect(s.active?.refresher).toBe(true);
    expect(s.active?.planPause?.question).toEqual(question);
    expect(s.canResume(ticket, 30, true)).toBe(false);
    s.active!.state = 'passed';
    expect(s.canUserResume(ticket, 30, true)).toBe(true);
    expect(s.canUserResume(ticket, 31, true)).toBe(false);
  });
  it('does not consume lesson tasks, replace plan content or acquire a second active attempt', () => {
    const s = new PlaybackSession(); s.navigate(fixture.videoId);
    s.acceptPlan(s.generation, plan, defaultSettings);
    const before = s.timelineMarkers(20000);
    const ticket = s.startRefresher(question, 40, true)!;
    expect(s.startRefresher(question, 40, true)).toBeNull();
    expect(s.consumed.size).toBe(0); expect(s.solvedIds.size).toBe(0);
    s.acceptPlan(s.generation, plan, defaultSettings);
    expect(s.isCurrent(ticket)).toBe(true);
    expect(s.timelineMarkers(20000)).toEqual(before);
    s.skip(); s.interrupt();
    expect(s.timelineMarkers(20000)).toEqual(before);
  });
  it('invalidates pending answers on skip, account interruption and navigation', () => {
    const s = new PlaybackSession(); s.navigate(fixture.videoId);
    s.startRefresher(question, 40, true); const grading = s.beginGrade()!;
    s.skip(); expect(s.isCurrent(grading)).toBe(false);
    s.interrupt(); expect(s.active).toBeNull();
    s.startRefresher(question, 41, true); const next = s.beginGrade()!;
    s.navigate('another0001'); expect(s.isCurrent(next)).toBe(false);
  });
  it('rejects absent routes and invalid media times', () => {
    const s = new PlaybackSession();
    expect(s.startRefresher(question, 10, true)).toBeNull();
    s.navigate(fixture.videoId);
    for (const time of [NaN, Infinity, -1]) expect(s.startRefresher(question, time, true)).toBeNull();
  });
});
