import { afterEach, describe, expect, it, vi } from 'vitest';
import ready from '../../../contracts/v2/exercise-plan.fixture.json';
import unavailable from '../../../contracts/v2/exercise-plan-not-coding.fixture.json';
import failed from '../../../contracts/v2/feedback-result.failed.fixture.json';
import practiceEvents from '../../../contracts/v2/practice-events.fixture.json';
import { ExercisePlanSchema, FeedbackSchema, PracticeEventSchema } from '../../src/plan/schemas';
import { pausesFor } from '../../src/plan';
import { PlaybackSession, type Sample } from '../../src/playback';
import { defaultSettings, readAccount, readSettings } from '../../src/plan/settings';
import { WatchSegments } from '../../src/plan/watch';
import { EventQueue, type EventStorage } from '../../src/plan/events';
import { requestPlanApi } from '../../src/plan/api';
import { PlanLoader } from '../../src/plan/loader';

const plan = () => ExercisePlanSchema.parse(structuredClone(ready));
const sample = (time: number, wallMs: number): Sample => ({ time, wallMs, rate: 1, playing: true,
  visible: true, ad: false, fullscreen: false, seeking: false, mountable: true, ready: true });
afterEach(() => vi.useRealTimers());

describe('v2 plan boundary and scheduling', () => {
  it('validates the frozen fixtures, including non-coding and feedback/events', () => {
    expect(plan()).toEqual(ready);
    expect(ExercisePlanSchema.parse(unavailable)).toEqual(unavailable);
    expect(FeedbackSchema.parse(failed)).toEqual(failed);
    practiceEvents.events.forEach(e => expect(PracticeEventSchema.parse(e)).toEqual(e));
  });
  it('rejects duplicate pauses, wrong kinds, invalid times and leaked answers', () => {
    const p = plan();
    expect(ExercisePlanSchema.safeParse({ ...p, pauses: [p.pauses[0], p.pauses[0]] }).success).toBe(false);
    expect(ExercisePlanSchema.safeParse({ ...p, pauses: [{ ...p.pauses[0], kind: 'concept' }] }).success).toBe(false);
    expect(ExercisePlanSchema.safeParse({ ...p, pauses: [{ ...p.pauses[0], revealAtS: 0 }] }).success).toBe(false);
    expect(ExercisePlanSchema.safeParse({ ...p, pauses: [{ ...p.pauses[0], exercise: { ...p.pauses[0]!.exercise, solution: 'answer' } }] }).success).toBe(false);
  });
  it('honors rank, readiness and qualified sections', () => {
    const p = plan();
    expect(pausesFor(p, 'few').map(p => p.id)).toEqual(['p1']);
    expect(pausesFor(p, 'normal').map(p => p.id)).toEqual(['p1', 'p2']);
    expect(pausesFor(p, 'many').map(p => p.id)).toEqual(['p1', 'p2']);
    p.sections[0]!.qualifies = false;
    expect(pausesFor(p, 'many').map(p => p.id)).toEqual(['p2']);
    p.status = 'error'; expect(pausesFor(p, 'many')).toEqual([]);
  });
  it('never backfills a pause whose content arrived after crossing', () => {
    const s = new PlaybackSession(); s.navigate(ready.videoId);
    const pending = plan(); pending.pauses[0]!.ready = false;
    s.acceptPlan(s.generation, pending, defaultSettings);
    s.sample(sample(9803, 1000));
    s.acceptPlan(s.generation, plan(), defaultSettings);
    expect(s.sample(sample(9803.4, 1400))).toBeNull();
    expect(s.sample(sample(9803.6, 1600))).toBeNull();
  });
  it('preserves crossings for unchanged polls', () => {
    const s = new PlaybackSession(); s.navigate(ready.videoId); s.acceptPlan(s.generation, plan(), defaultSettings);
    s.sample(sample(9803, 1000)); s.acceptPlan(s.generation, plan(), defaultSettings);
    expect(s.sample(sample(9803.4, 1400))?.id).toBe('p1');
  });
  it('opens ready concept questions with their own revision and no reveal timestamp', () => {
    const s = new PlaybackSession(); s.navigate(ready.videoId); s.acceptPlan(s.generation, plan(), defaultSettings);
    s.sample(sample(10119.8, 1000)); expect(s.sample(sample(10120.1, 1300))?.id).toBe('p2');
    expect(s.active?.revision).toBe('r1'); expect(s.active?.planPause?.kind).toBe('concept');
    const active = s.active; s.acceptPlan(s.generation, plan(), defaultSettings); expect(s.active).toBe(active);
  });
  it.each([{ ...defaultSettings, autoPause: false }, { ...defaultSettings, disabledVideos: [ready.videoId] }])('respects stored auto-pause controls', settings => {
    const s = new PlaybackSession(); s.navigate(ready.videoId); s.acceptPlan(s.generation, plan(), settings);
    s.sample(sample(9803, 1000)); expect(s.sample(sample(9803.4, 1400))).toBeNull();
  });
  it('ignores a previous route and malformed settings fail closed', () => {
    const s = new PlaybackSession(); const old = s.navigate(ready.videoId); s.navigate(unavailable.videoId);
    expect(s.acceptPlan(old, plan(), defaultSettings)).toBe(false);
    expect(readSettings(undefined).autoPause).toBe(true); expect(readSettings({ autoPause: 'false' }).autoPause).toBe(false);
    expect(readAccount(undefined)).toBe('test-ana'); expect(readAccount('test-ben')).toBe('test-ben');
  });
});

describe('honest watch time', () => {
  it('emits only played intervals across seeking, buffering and pauses', () => {
    const emit = vi.fn(); const watch = new WatchSegments(emit);
    watch.sample(sample(0, 0)); watch.sample(sample(0.5, 500));
    watch.sample({ ...sample(90, 600), seeking: true });
    watch.sample(sample(90, 1000)); watch.sample(sample(90.5, 1500));
    watch.sample({ ...sample(90.5, 1600), playing: false });
    watch.sample(sample(90.5, 10000)); watch.sample(sample(91, 10500)); watch.reset();
    expect(emit.mock.calls.map(c => c[0])).toEqual([[0, 0.5], [90, 90.5], [90.5, 91]]);
  });
  it('drops unannounced jumps and callback gaps; honors playback rate and excludes ads', () => {
    const emit = vi.fn(); const watch = new WatchSegments(emit);
    watch.sample(sample(0, 0)); watch.sample(sample(30, 500)); watch.sample(sample(40, 10000));
    watch.sample({ ...sample(41, 10500), rate: 2 });
    watch.sample({ ...sample(42, 11000), ad: true }); watch.reset();
    expect(emit.mock.calls.map(c => c[0])).toEqual([[40, 41]]);
  });
});

describe('durable event queue', () => {
  function fixture() {
    const values: Record<string, unknown> = {};
    const storage: EventStorage = { get: async () => ({ ...values }), set: async entries => { Object.assign(values, entries); },
      remove: async keys => { keys.forEach(key => delete values[key]); } };
    const event = PracticeEventSchema.parse(practiceEvents.events[0]);
    return { values, storage, event };
  }
  it('retains offline data and reuses IDs after a worker restart', async () => {
    const { values, storage, event } = fixture();
    const offline = new EventQueue(storage, async () => false); await offline.enqueue([event]); await offline.flush();
    expect(Object.keys(values)).toHaveLength(1);
    const deliver = vi.fn(async () => true); await new EventQueue(storage, deliver).flush();
    expect(deliver).toHaveBeenCalledWith([event]); expect(values).toEqual({});
  });
  it('preserves events added during delivery and serializes concurrent flushes', async () => {
    const { values, storage, event } = fixture(); let ack!: (ok: boolean) => void;
    const deliver = vi.fn(() => new Promise<boolean>(resolve => { ack = resolve; }));
    const queue = new EventQueue(storage, deliver); await queue.enqueue([event]);
    const first = queue.flush(); const second = queue.flush(); await Promise.resolve();
    await queue.enqueue([{ ...event, id: 'e-new', accountId: 'test-ben' }]); ack(true); await Promise.all([first, second]);
    expect(deliver).toHaveBeenCalledTimes(1); expect(Object.keys(values)).toEqual(['breakpoint:event:e-new']);
  });
  it('keeps a delivered batch if storage deletion fails for safe idempotent retry', async () => {
    const { storage, event, values } = fixture(); const deliver = vi.fn(async () => true);
    const queue = new EventQueue({ ...storage, remove: async () => { throw new Error('disk'); } }, deliver);
    await queue.enqueue([event]); await expect(queue.flush()).rejects.toThrow('disk'); expect(Object.keys(values)).toHaveLength(1);
  });
  it('retains rejected records from a partial successful batch', async () => {
    const { storage, event, values } = fixture();
    const queue = new EventQueue(storage, async () => ['accepted']);
    await queue.enqueue([event, { ...event, id: 'accepted' }]); await queue.flush();
    expect(Object.keys(values)).toEqual(['breakpoint:event:' + event.id]);
  });
});

describe('v2 transport and polling', () => {
  it('rejects arbitrary URLs, invalid messages and mismatched video responses', async () => {
    const fetcher = vi.fn(async () => Response.json(ready));
    expect((await requestPlanApi({ type: 'plan', videoId: ready.videoId, learnerLevel: 'beginner-1', url: 'https://evil.test' }, 'http://127.0.0.1:8000', fetcher)).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await requestPlanApi({ type: 'pollPlan', videoId: unavailable.videoId }, 'http://127.0.0.1:8000', fetcher)).ok).toBe(false);
  });
  it('posts only validated fields and accepts an empty successful event ACK', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const event = PracticeEventSchema.parse(practiceEvents.events[0]);
    expect((await requestPlanApi({ type: 'eventsV2', events: [event] }, 'http://127.0.0.1:8000', fetcher)).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8000/v2/events', expect.objectContaining({ body: JSON.stringify({ events: [event] }), redirect: 'error', credentials: 'omit' }));
  });
  it('forwards the concept-level map and rejects another learner\'s level', async () => {
    const fetcher = vi.fn(async () => Response.json(ready));
    const body = { videoId: ready.videoId, learnerLevel: 'beginner-1', learnerLevels: { loops: 'intermediate-1' } };
    expect((await requestPlanApi({ type: 'plan', ...body }, 'http://127.0.0.1:8000', fetcher)).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8000/v2/plan', expect.objectContaining({ body: JSON.stringify(body) }));
    const other = vi.fn(async () => Response.json({ accountId: 'test-ben', levels: { loops: 'expert-10' } }));
    expect((await requestPlanApi({ type: 'levelsV2', accountId: 'test-ana' }, 'http://127.0.0.1:8000', other)).ok).toBe(false);
  });
  it('acknowledges only the event IDs B1 accepted and rejects malformed ACKs', async () => {
    const first = PracticeEventSchema.parse(practiceEvents.events[0]); const second = { ...first, id: 'e-other' };
    const message = { type: 'eventsV2', events: [first, second] };
    const fetcher = vi.fn(async () => Response.json({ accepted: 1, duplicates: 0, rejected: [{ id: second.id, reason: 'invalid' }] }));
    expect(await requestPlanApi(message, 'http://127.0.0.1:8000', fetcher)).toEqual({ ok: true, data: { acknowledgedIds: [first.id] } });
    expect((await requestPlanApi(message, 'http://127.0.0.1:8000', async () => Response.json({ accepted: 1 }))).ok).toBe(false);
  });
  it('rejects mismatched feedback before it can solve a different question', async () => {
    const fetcher = vi.fn(async () => Response.json({ correct: false, feedback: failed }));
    expect((await requestPlanApi({ type: 'answerV2', questionId: 'different-question', revision: 'r1', answer: 'a',
      learnerLevel: 'beginner-1' }, 'http://127.0.0.1:8000', fetcher)).ok).toBe(false);
  });
  it('polls planning results and stops after ready', async () => {
    vi.useFakeTimers(); const accept = vi.fn();
    const request = vi.fn().mockResolvedValueOnce({ ok: true, data: { ...plan(), status: 'planning' } }).mockResolvedValue({ ok: true, data: plan() });
    const loader = new PlanLoader(request, accept); loader.start(); await vi.advanceTimersByTimeAsync(15000);
    expect(request.mock.calls).toEqual([[false], [true]]); expect(accept).toHaveBeenCalledTimes(2); loader.stop();
  });
  it('suppresses in-flight results after navigation', async () => {
    let resolve!: (value: any) => void; const accept = vi.fn();
    const loader = new PlanLoader(() => new Promise(done => { resolve = done; }), accept);
    loader.start(); loader.stop(); resolve({ ok: true, data: plan() }); await Promise.resolve();
    expect(accept).not.toHaveBeenCalled();
  });
  it('retries transient transport failures without creating concurrent polls', async () => {
    vi.useFakeTimers(); const accept = vi.fn();
    const request = vi.fn().mockResolvedValueOnce({ ok: false, error: { error: { retryable: true } } })
      .mockResolvedValue({ ok: true, data: plan() });
    const loader = new PlanLoader(request, accept); loader.start(); await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(2); expect(accept).toHaveBeenCalledTimes(1); loader.stop();
  });
});
