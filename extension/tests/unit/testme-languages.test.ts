import { describe, expect, it } from 'vitest';
import testMe from '../../../contracts/testme-response.fixture.json';
import practice from '../../../contracts/practice-response.fixture.json';
import { CODING_LANGUAGES, ExerciseSchema, PracticeResponseSchema, TestMeResponseSchema } from '../../src/contracts';
import { PlaybackSession } from '../../src/playback';

// A JavaScript Test me reply as the backend sends it for a JS tutorial (#31/#32).
const jsTestMe = {
  ...testMe,
  setId: 'tm-js-sum-evens',
  exercise: {
    id: 'tm-js-sum-evens', title: 'Sum the even numbers', language: 'javascript',
    statement: 'Write sumEvens(nums) that returns the sum of the even numbers in nums.',
    starterCode: 'function sumEvens(nums) {\n  // your code here\n}\n',
    examples: [{ args: [[1, 2, 3, 4]], expected: 6 }, { args: [[]], expected: 0 }],
  },
};

describe('Test me in any coding language', () => {
  it('accepts a JavaScript Test me reply unchanged', () => {
    expect(TestMeResponseSchema.parse(jsTestMe)).toEqual(jsTestMe);
  });

  it.each(CODING_LANGUAGES)('accepts %s exercises', language => {
    expect(ExerciseSchema.safeParse({ ...testMe.exercise, language }).success).toBe(true);
  });

  it.each(['sql', 'pseudocode', 'unknown', 'Python', 'ruby', ''])('rejects %j as a coding exercise language', language => {
    expect(ExerciseSchema.safeParse({ ...testMe.exercise, language }).success).toBe(false);
  });

  it('keeps the Python fixtures valid', () => {
    expect(TestMeResponseSchema.parse(testMe)).toEqual(testMe);
    expect(PracticeResponseSchema.parse(practice)).toEqual(practice);
  });

  it('hands the exercise language to the active panel breakpoint', () => {
    const session = new PlaybackSession();
    session.navigate(practice.videoId);
    const ticket = session.startTestMe(120, true)!;
    expect(session.finishTestMe(ticket, { ok: true, data: TestMeResponseSchema.parse(jsTestMe) })).toBe(true);
    expect(session.active?.breakpoint.exercise.language).toBe('javascript');
    expect(session.active?.breakpoint.exercise.starterCode).toContain('function sumEvens');
  });
});
