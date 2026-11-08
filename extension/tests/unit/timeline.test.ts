import { afterEach, describe, expect, it, vi } from 'vitest';
import preparedFixture from '../../../contracts/practice-response.fixture.json';
import planFixture from '../../../contracts/v2/exercise-plan.fixture.json';
import { PracticeResponseSchema } from '../../src/contracts';
import { ExercisePlanSchema } from '../../src/plan/schemas';
import { defaultSettings } from '../../src/plan/settings';
import { seekForPractice } from '../../src/plan/timeline';
import { PlaybackSession } from '../../src/playback';

afterEach(() => vi.useRealTimers());
const planSession = () => {
  const s = new PlaybackSession();
  const plan = ExercisePlanSchema.parse(structuredClone(planFixture));
  s.acceptPlan(s.navigate(plan.videoId), plan, defaultSettings);
  return { s, plan };
};

describe('timeline data and explicit review', () => {
  it('positions ready coding/concept markers with completion states', () => {
    const { s } = planSession();
    const [coding, concept] = s.data!.breakpoints;
    s.consumed.add(coding!.id);
    s.solvedIds.add(concept!.exercise.id);
    const markers = s.timelineMarkers(11000);
    expect(markers.map(m => [m.kind, m.status])).toEqual([['coding', 'attempted'], ['concept', 'passed']]);
    expect(markers[0]!.position).toBeCloseTo(markers[0]!.timeS / 11000 * 100);
    expect(markers[0]!.concepts.length).toBeGreaterThan(0);
  });
  it('does not expose unready, unqualified or frequency-excluded tasks', () => {
    const { s, plan } = planSession();
    plan.pauses[0]!.ready = false;
    s.acceptPlan(s.generation, plan, { ...defaultSettings, frequency: 'few' });
    expect(s.timelineMarkers(11000)).toEqual([]);
    plan.pauses[0]!.ready = true; plan.sections[0]!.qualifies = false;
    s.acceptPlan(s.generation, plan, defaultSettings);
    expect(s.timelineMarkers(11000).map(m => m.id)).toEqual(['p2']);
  });
  it('hides invalid/live durations and out-of-range pauses', () => {
    const { s } = planSession();
    for (const duration of [NaN, Infinity, 0, -1, 20]) expect(s.timelineMarkers(duration)).toEqual([]);
  });
  it('supports prepared lessons without inventing concept tags', () => {
    const data = PracticeResponseSchema.parse(preparedFixture);
    const s = new PlaybackSession(); s.acceptLookup(s.navigate(data.videoId), data);
    expect(s.timelineMarkers(100)[0]).toMatchObject({ timeS: 72, position: 72, kind: 'coding', concepts: [] });
  });
  it('reopens a skipped task for a first pass, but solved tasks are review-only', () => {
    const { s } = planSession(); const b = s.data!.breakpoints[0]!;
    s.open(b, b.pauseAtS, true); s.skip(); s.interrupt();
    expect(s.open(b, b.pauseAtS, true)).toBeNull();
    expect(s.openFromTimeline(b.id, b.pauseAtS, false)).not.toBeNull();
    expect(s.active?.reviewOnly).toBe(false);
    s.interrupt(); s.solvedIds.add(b.exercise.id);
    s.openFromTimeline(b.id, b.pauseAtS, false);
    expect(s.active?.reviewOnly).toBe(true);
    expect(s.active?.ownsPause).toBe(false);
  });
  it('refuses stale/removed markers and never replaces an open attempt', () => {
    const { s, plan } = planSession(); const old = s.data!.breakpoints[0]!;
    plan.pauses = plan.pauses.slice(1); s.acceptPlan(s.generation, plan, defaultSettings);
    expect(s.openFromTimeline(old.id, old.pauseAtS, true)).toBeNull();
    const current = s.data!.breakpoints[0]!;
    const ticket = s.openFromTimeline(current.id, current.pauseAtS, true)!;
    expect(s.openFromTimeline(current.id, current.pauseAtS, true)).toBeNull();
    s.navigate('different01'); expect(s.isCurrent(ticket)).toBe(false);
    expect(s.timelineMarkers(11000)).toEqual([]);
  });
  it('resolves the current revision rather than the clicked snapshot', () => {
    const { s, plan } = planSession(); const old = s.data!.breakpoints[0]!;
    plan.pauses[0]!.exercise!.revision = 'r2';
    plan.pauses[0]!.exercise!.title = 'Updated task';
    s.acceptPlan(s.generation, plan, defaultSettings);
    s.openFromTimeline(old.id, old.pauseAtS, true);
    expect(s.active?.revision).toBe('r2');
    expect(s.active?.breakpoint.exercise.title).toBe('Updated task');
  });
  it('a failed review mount does not rearm an already consumed pause', () => {
    const { s } = planSession(); const b = s.data!.breakpoints[0]!;
    s.consumed.add(b.id); s.openFromTimeline(b.id, b.pauseAtS, true); s.releaseFailedMount();
    expect(s.consumed.has(b.id)).toBe(true);
  });
});

class Media extends EventTarget {
  currentTime = 0;
  seeking = false;
  paused = false;
  pause() { this.paused = true; }
}
describe('timeline seek lifecycle', () => {
  it('waits for a completed paused seek', async () => {
    const media = new Media(); media.seeking = true;
    const result = seekForPractice(media, 72, new AbortController().signal);
    expect(media.paused).toBe(true); expect(media.currentTime).toBe(72);
    media.seeking = false; media.dispatchEvent(new Event('seeked'));
    expect(await result).toBe(true);
  });
  it('opens immediately when already at the target without relying on seeked', async () => {
    const media = new Media(); media.currentTime = 72;
    expect(await seekForPractice(media, 72, new AbortController().signal)).toBe(true);
  });
  it.each(['play', 'emptied', 'error'])('native %s cancels pending selection', async event => {
    const media = new Media(); const result = seekForPractice(media, 72, new AbortController().signal);
    media.dispatchEvent(new Event(event)); expect(await result).toBe(false);
    media.dispatchEvent(new Event('seeked'));
  });
  it('navigation/account abort, another seek and timeout never open stale panels', async () => {
    vi.useFakeTimers(); const media = new Media(); const controller = new AbortController();
    const aborted = seekForPractice(media, 72, controller.signal); controller.abort(); expect(await aborted).toBe(false);
    const moved = seekForPractice(media, 90, new AbortController().signal);
    media.currentTime = 30; media.dispatchEvent(new Event('seeked')); expect(await moved).toBe(false);
    const stalled = seekForPractice(media, 90, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5000); expect(await stalled).toBe(false);
  });
});
