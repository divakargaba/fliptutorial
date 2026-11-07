import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/practice-response.fixture.json';
import { PracticeResponseSchema, type SubmissionResponse } from '../../src/contracts';
import { PlaybackSession, watchVideoId, type Sample } from '../../src/playback';

const data = PracticeResponseSchema.parse(fixture);
const breakpoint = data.breakpoints[0]!;
const passed: SubmissionResponse = {
  outcome: 'passed', passedCount: 1, totalCount: 1,
  results: [{ kind: 'visible', index: 0, passed: true }],
};

function ready() {
  const session = new PlaybackSession();
  session.acceptLookup(session.navigate(data.videoId), data);
  return session;
}

function sample(time: number, wallMs: number, overrides: Partial<Sample> = {}): Sample {
  return { time, wallMs, rate: 1, playing: true, visible: true, ad: false, fullscreen: false,
    seeking: false, mountable: true, ready: true, ...overrides };
}

function paused() {
  const session = ready();
  session.sample(sample(71.8, 0));
  expect(session.sample(sample(72, 200))).toEqual(breakpoint);
  return session;
}

describe('YouTube watch routes', () => {
  it('recognizes the current watch video and ignores unrelated locations', () => {
    expect(watchVideoId('https://www.youtube.com/watch?t=5&v=samplevid01')).toBe('samplevid01');
    for (const url of ['https://youtu.be/samplevid01', 'https://www.youtube.com/shorts/samplevid01',
      'https://www.youtube.com/watch?v=short', 'https://example.com/watch?v=samplevid01', 'bad URL']) {
      expect(watchVideoId(url)).toBeNull();
    }
  });
});

describe('automatic pause', () => {
  it('claims the exact threshold once across repeated samples and a rewind', () => {
    const session = paused();
    expect(session.sample(sample(72, 201))).toBeNull();
    session.skip();
    session.interrupt();
    expect(session.sample(sample(71.8, 500))).toBeNull();
    expect(session.sample(sample(72.1, 800))).toBeNull();
  });

  it('crosses the threshold between frames at 2×', () => {
    const session = ready();
    session.sample(sample(71.9, 0, { rate: 2 }));
    expect(session.sample(sample(72.1, 100, { rate: 2 }))).toEqual(breakpoint);
  });

  it('never pauses at or after the reveal', () => {
    const session = ready();
    session.sample(sample(71.9, 0, { rate: 2 }));
    expect(session.sample(sample(74, 1050, { rate: 2 }))).toBeNull();
  });

  it.each<Partial<Sample>>([{ ad: true }, { visible: false }, { fullscreen: true },
    { seeking: true }, { mountable: false }, { ready: false }, { playing: false }])(
    'suppresses and resets around %j', flags => {
      const session = ready();
      session.sample(sample(71.8, 0));
      expect(session.sample(sample(72, 200, flags))).toBeNull();
      expect(session.sample(sample(72.2, 400))).toBeNull();
      expect(session.open(breakpoint, 72.2, true)).not.toBeNull();
    },
  );

  it('allows a normal crossing after rewinding past a missed breakpoint', () => {
    const session = ready();
    session.sample(sample(50, 0));
    expect(session.sample(sample(72.4, 100))).toBeNull();
    expect(session.sample(sample(71.9, 200))).toBeNull();
    expect(session.sample(sample(72, 300))).toEqual(breakpoint);
  });

  it('does not treat a paused callback or a replacement player as continuous playback', () => {
    const session = ready();
    session.sample(sample(71.9, 0));
    expect(session.sample(sample(72.2, 1800))).toBeNull();
    session.reset();
    expect(session.sample(sample(72.3, 2000))).toBeNull();
  });

  it('does not pause retroactively if the catalog arrives late', () => {
    const session = new PlaybackSession();
    const generation = session.navigate(data.videoId);
    session.sample(sample(71.9, 0));
    session.acceptLookup(generation, data);
    expect(session.sample(sample(72.3, 400))).toBeNull();
    expect(session.active).toBeNull();
  });

  it('releases a failed mount so the exercise remains available', () => {
    const session = paused();
    session.releaseFailedMount();
    expect(session.active).toBeNull();
    expect(session.consumed.size).toBe(0);
    expect(session.open(breakpoint, 72, false)).not.toBeNull();
  });
});

describe('grading and resume ownership', () => {
  it('keeps the video paused after Run passes, then resumes after Submit passes', () => {
    const session = paused();
    expect(session.finishGrade(session.beginGrade()!, 'run', { ok: true, data: passed })).toBe('stay');
    expect(session.active?.state).toBe('editing');
    const ticket = session.beginGrade()!;
    expect(session.beginGrade()).toBeNull();
    expect(session.finishGrade(ticket, 'submit', { ok: true, data: passed })).toBe('resume');
    expect(session.canResume(ticket, 72, true)).toBe(true);
    expect(session.canResume(ticket, 73, true)).toBe(false);
  });

  it('leaves a video paused by the learner under native control', () => {
    const session = ready();
    session.open(breakpoint, 72, false);
    const ticket = session.beginGrade()!;
    expect(session.finishGrade(ticket, 'submit', { ok: true, data: passed })).toBe('stay');
    expect(session.canResume(ticket, 72, true)).toBe(false);
  });

  it('ignores a pending result after Skip, even when play rejects', () => {
    const session = paused();
    const grade = session.beginGrade()!;
    const skip = session.skip()!;
    session.resumeRejected(skip);
    expect(session.active?.canResume).toBe(true);
    expect(session.canResume(skip, 72, true)).toBe(true);
    expect(session.finishGrade(grade, 'submit', { ok: true, data: passed })).toBe('ignored');
  });

  it('ignores late results on navigation or native interruption', () => {
    const session = paused();
    const ticket = session.beginGrade()!;
    session.interrupt();
    expect(session.finishGrade(ticket, 'submit', { ok: true, data: passed })).toBe('ignored');
    session.navigate('otherVideo1');
    expect(session.acceptLookup(ticket.generation, data)).toBe(false);
    expect(session.canResume(ticket, 72, true)).toBe(false);
  });
});
