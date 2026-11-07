import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { sendRequest } from '../../src/api';
import { PracticeResponseSchema, SubmissionResponseSchema } from '../../src/contracts';

const practice = JSON.parse(readFileSync(new URL('../../../contracts/practice-response.fixture.json', import.meta.url), 'utf8'));
const disconnected = () => new Error('Could not establish connection. Receiving end does not exist.');

test('cold worker lookup recovers after two missing-listener failures', async () => {
  let calls = 0;
  const reply = await sendRequest({ type: 'lookup', videoId: practice.videoId }, PracticeResponseSchema, async () => {
    if (++calls <= 2) throw disconnected();
    return { ok: true, data: practice };
  });
  expect(reply).toEqual({ ok: true, data: practice });
  expect(calls).toBe(3);
});

test('a cold worker failure never sends a grade twice', async () => {
  let calls = 0;
  const reply = await sendRequest({ type: 'grade', exerciseId: 'demo', revision: 'demo', mode: 'submit', code: 'pass' }, SubmissionResponseSchema, async () => {
    calls++;
    throw disconnected();
  });
  expect(reply.ok).toBe(false);
  expect(calls).toBe(1);
});

test('lookup retry stays bounded when the worker remains absent', async () => {
  let calls = 0;
  const reply = await sendRequest({ type: 'lookup', videoId: practice.videoId }, PracticeResponseSchema, async () => {
    calls++;
    throw disconnected();
  });
  expect(reply.ok).toBe(false);
  expect(calls).toBe(3);
});
