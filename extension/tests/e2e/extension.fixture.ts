import { test as base, chromium, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AnalysisResponse, HintResponse, LastResult, PracticeResponse } from '../../src/contracts';
import type { ExercisePlan, PracticeEvent } from '../../src/v2/types';
import type { Refresher } from '../../src/plan/schemas';
const practice: PracticeResponse = JSON.parse(readFileSync(new URL('../../../contracts/practice-response.fixture.json', import.meta.url), 'utf8'));
const failed = JSON.parse(readFileSync(new URL('../../../contracts/submission-response.fixture.json', import.meta.url), 'utf8'));
const publicProfile = JSON.parse(readFileSync(new URL('../../../contracts/v2/public-profile.fixture.json', import.meta.url), 'utf8'));
export const generated = JSON.parse(readFileSync(new URL('../../../contracts/testme-response.fixture.json', import.meta.url), 'utf8'));
export const hintFixture: HintResponse = JSON.parse(readFileSync(new URL('../../../contracts/hint-response.fixture.json', import.meta.url), 'utf8'));
export const analysisFixture: AnalysisResponse = JSON.parse(readFileSync(new URL('../../../contracts/analysis-response.fixture.json', import.meta.url), 'utf8'));
type HintRequest = { exerciseId: string; revision: string; code: string; level: number; lastResult?: LastResult; previousHints?: string[] };
type AnalysisRequest = { exerciseId: string; revision: string; code: string };

export const watchUrl = 'https://www.youtube.com/watch?v=samplevid01';
export const pauseAtS = 1.2;
export const secondPauseAtS = 3.0;
export const secondTitle = 'Try a second exponent';
export const correctCode = 'def raise_to_power(base, exponent):\n    return base ** exponent';
type Submission = { exerciseId: string; revision: string; mode: 'run' | 'submit'; code: string };
type App = {
  page: Page;
  planRequests: Array<{ videoId: string; learnerLevels: Record<string, string> }>;
  answers: Array<{ questionId: string; answer: string }>;
  events: PracticeEvent[];
  awardRequests: string[];
  requests: Submission[];
  hold: boolean;
  unavailable: boolean;
  failure: { status: number; code: string; retryable: boolean } | null;
  revision: string;
  lookupCount: number;
  generations: Array<{ videoId: string; timestampS: number }>;
  holdGeneration: boolean;
  generationFailure: { status: number; code: string; retryable: boolean } | null;
  hints: HintRequest[];
  hintText?: string;
  analyses: AnalysisRequest[];
  analysis: AnalysisResponse;
  holdAnalysis: boolean;
  release(): Promise<void>;
  rejectResume(reject: boolean): Promise<void>;
};

export const test = base.extend<{ app: App; breakpointCount: 1 | 2; preparedVideo: boolean; plan: ExercisePlan | null; refresher: Refresher | null; planningPolls: number; planErrors: number; delayedPlayer: boolean; award: 'progress' | 'levelUp' | null }>({
  breakpointCount: [1, { option: true }],
  preparedVideo: [true, { option: true }],
  plan: [null, { option: true }],
  // Opt-in B1 award response; without it every award request is 404 EVENT_NOT_FOUND.
  award: [null, { option: true }],
  refresher: [null, { option: true }],
  planningPolls: [0, { option: true }],
  planErrors: [0, { option: true }],
  delayedPlayer: [false, { option: true }],
  app: async ({ viewport, breakpointCount, preparedVideo, plan, refresher, planningPolls, planErrors, delayedPlayer, award }, use) => {
    const requests: Submission[] = [];
    const pending: Array<() => void> = [];
    const releasePending = () => pending.splice(0).forEach(fn => fn());
    const app = { requests, planRequests: [], answers: [], events: [], awardRequests: [], hold: false, unavailable: false, failure: null, revision: practice.revision!, lookupCount: 0,
      generations: [], holdGeneration: false, generationFailure: null,
      hints: [], analyses: [], holdAnalysis: false,
      analysis: { ...analysisFixture, optimal: true, best: analysisFixture.learner, betterSolution: null } } as App;
    const api = new URL(process.env.WXT_API_BASE_URL || 'http://127.0.0.1:8000');
    if (api.hostname !== '127.0.0.1' || api.protocol !== 'http:') throw new Error('The test API must use HTTP loopback.');
    const [original] = practice.breakpoints;
    const first = { ...original!, pauseAtS, revealAtS: breakpointCount === 2 ? 2.6 : 10 };
    const breakpoints = breakpointCount === 1 ? [first] : [first, {
      ...first, id: 'second-breakpoint', pauseAtS: secondPauseAtS, revealAtS: 10,
      exercise: { ...first.exercise, id: 'samplevid01-second', title: secondTitle },
    }];
    const server = createServer(async (req, res) => {
      const json = (status: number, body: unknown) => {
        if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url?.startsWith('/v2/refresher/')) {
        if (refresher && req.url === `/v2/refresher/${refresher.accountId}`) json(200, refresher);
        else res.writeHead(204).end();
      } else if (req.method === 'POST' && req.url === '/v2/plan' && plan) {
        let body = '';
        for await (const chunk of req) body += chunk;
        app.planRequests.push(JSON.parse(body));
        json(200, app.planRequests.length <= planErrors
          ? { ...plan, status: 'error', verdict: { qualifies: false, reason: 'Fixture planner unavailable.', evidence: [] }, pauses: [] }
          : app.planRequests.length <= planningPolls ? { ...plan, status: 'planning', pauses: [] } : plan);
      } else if (req.method === 'POST' && (req.url === '/v2/submit' || req.url === '/v2/answer')) {
        let body = '';
        for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        const feedback = JSON.parse(readFileSync(new URL('../../../contracts/v2/feedback-result.passed.fixture.json', import.meta.url), 'utf8'));
        feedback.exerciseId = input.exerciseId ?? input.questionId;
        feedback.summary = feedback.success.explanation;
        feedback.success.optimization.show = false;
        if (req.url === '/v2/answer') {
          app.answers.push(input);
          json(200, { correct: true, feedback });
        } else {
          requests.push(input);
          json(200, { grade: { outcome: 'passed', passedCount: 1, totalCount: 1,
            results: [{ kind: 'visible', index: 0, passed: true, args: [2, 3], expected: 8, actual: 8, diagnostic: null }] }, feedback });
        }
      } else if (req.method === 'POST' && req.url === '/v2/events') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const events = JSON.parse(body).events as PracticeEvent[];
        app.events.push(...events);
        json(200, { accepted: events.length, duplicates: 0, rejected: [] });
      } else if (req.method === 'GET' && req.url === '/v2/accounts') {
        json(200, [{ accountId: 'test-ana', displayName: 'Ana (test)' }, { accountId: 'test-ben', displayName: 'Ben (test)' }]);
      } else if (req.method === 'GET' && req.url?.startsWith('/v2/profile/') && req.url.includes('/award/')) {
        const [, , , accountId, , eventId] = req.url.split('/').map(decodeURIComponent);
        app.awardRequests.push(eventId!);
        // Like B1: 404 until the extension has actually delivered the event.
        const event = app.events.find(e => e.id === eventId && e.accountId === accountId);
        if (!award || !event) {
          json(404, { error: { code: 'EVENT_NOT_FOUND', message: 'event not delivered yet', retryable: false }, requestId: 'profile' });
          return;
        }
        const level = (id: string, name: string, rank: number, minXp: number) => ({ level: id, levelName: name, rank, minXp });
        const b1 = level('beginner-1', 'Beginner I', 1, 0), b2 = level('beginner-2', 'Beginner II', 2, 40), b3 = level('beginner-3', 'Beginner III', 3, 100);
        const up = award === 'levelUp';
        const awards = (event.concepts ?? []).map((concept, i) => i === 0
          ? { concept, conceptName: concept, primary: true, xpGained: 37.5, xpBefore: up ? 20 : 0, xp: up ? 57.5 : 37.5,
              levelBefore: b1, level: up ? b2 : b1, nextLevel: up ? b3 : b2, xpToNext: up ? 42.5 : 2.5,
              progress: up ? 0.292 : 0.938, leveledUp: up }
          : { concept, conceptName: concept, primary: false, xpGained: 18.8, xpBefore: 0, xp: 18.8,
              levelBefore: b1, level: b1, nextLevel: b2, xpToNext: 21.2, progress: 0.47, leveledUp: false });
        json(200, { accountId, eventId, type: event.type, totalXpGained: awards.reduce((n, a) => n + a.xpGained, 0),
          leveledUp: up, awards });
      } else if (req.method === 'GET' && req.url?.startsWith('/v2/profile/')) {
        const accountId = req.url.split('/')[3];
        if (req.url.endsWith('/levels')) {
          json(200, { accountId, levels: { loops: accountId === 'test-ben' ? 'intermediate-1' : 'beginner-1' } });
          return;
        }
        if (req.url.includes('/level/')) {
          json(200, { accountId, concept: req.url.split('/')[5], level: 'beginner-1', levelName: 'Beginner I', rank: 1, xp: 0, strength: 0 });
          return;
        }
        const ben = req.url.endsWith('/test-ben');
        json(200, { ...publicProfile, ...(ben ? { accountId: 'test-ben', displayName: 'Ben (test)', complements: [] } : {}) });
      } else if (req.method === 'GET' && req.url?.startsWith('/v1/videos/')) {
        app.lookupCount++;
        const id = req.url.split('/')[3];
        json(200, !plan && id === practice.videoId ? {
          ...practice, revision: app.revision, breakpoints: breakpoints.map(b => app.revision === practice.revision ? b : {
            ...b, exercise: { ...b.exercise, title: 'Updated exponent challenge' },
          }),
        } : { schemaVersion: 1, videoId: id, revision: null, status: 'unsupported', breakpoints: [] });
      } else if (req.method === 'POST' && req.url === '/v1/test-me') {
        let body = '';
        for await (const chunk of req) body += chunk;
        app.generations.push(JSON.parse(body));
        const respond = () => app.generationFailure
          ? json(app.generationFailure.status, { error: { code: app.generationFailure.code, retryable: app.generationFailure.retryable, message: `Fixture ${app.generationFailure.code}.` }, requestId: 'fixture-generation' })
          : json(200, generated);
        if (app.holdGeneration) pending.push(respond); else respond();
      } else if (req.method === 'POST' && req.url === '/v1/hints') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const input = JSON.parse(body) as HintRequest;
        app.hints.push(input);
        json(200, { ...hintFixture, level: input.level, hint: input.level === 0 ? null : `Hint ${input.level}: ${app.hintText ?? hintFixture.hint}` });
      } else if (req.method === 'POST' && req.url === '/v1/analysis') {
        let body = '';
        for await (const chunk of req) body += chunk;
        app.analyses.push(JSON.parse(body));
        const respond = () => json(200, app.analysis);
        if (app.holdAnalysis) pending.push(respond); else respond();
      } else if (req.method === 'POST' && req.url === '/v1/submissions') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const submission = JSON.parse(body) as Submission;
        requests.push(submission);
        const respond = () => {
          if (app.failure) {
            json(app.failure.status, { error: { code: app.failure.code, message: `Fixture ${app.failure.code}.`, retryable: app.failure.retryable }, requestId: 'fixture-failure' });
          } else if (app.unavailable) {
            json(503, { error: { code: 'GRADER_UNAVAILABLE', message: 'Fixture grader unavailable.', retryable: true }, requestId: 'fixture-request' });
          } else if (submission.code === correctCode) {
            const results = [{ kind: 'visible', index: 0, passed: true, args: [2, 3], expected: 8, actual: 8, diagnostic: null },
              ...(submission.mode === 'submit' ? [0, 1, 2].map(index => ({ kind: 'hidden', index, passed: true })) : [])];
            json(200, { outcome: 'passed', passedCount: results.length, totalCount: results.length, results });
          } else json(200, failed);
        };
        if (app.hold) pending.push(respond); else respond();
      } else json(404, {});
    });
    // Fail if a developer's backend already owns this port; never send fixtures to it.
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(api.port || 80), '127.0.0.1', resolve); });
    let context;
    try {
      context = await chromium.launchPersistentContext('', {
        channel: 'chromium', headless: true, viewport,
        args: ['--enable-unsafe-extension-debugging', '--disable-extensions-except=' + fileURLToPath(new URL('../../.output/chrome-mv3', import.meta.url))],
      });
      const page = context.pages()[0] ?? await context.newPage();
      app.release = async () => {
        if (!pending.length) return;
        const downloaded = context.waitForEvent('requestfinished', request =>
          ['/v1/submissions', '/v1/test-me', '/v1/analysis'].some(path => request.url() === `${api.origin}${path}`));
        releasePending();
        await downloaded;
        // Let the worker message and the content renderer run after the fetch finishes.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      };
      const browserCdp = await context.browser()!.newBrowserCDPSession();
      const { id } = await browserCdp.send('Extensions.loadUnpacked', {
        path: fileURLToPath(new URL('../../.output/chrome-mv3', import.meta.url)),
      });
      const cdp = await context.newCDPSession(page);
      const worlds: Array<{ id: number; origin: string; name: string }> = [];
      cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
      await cdp.send('Runtime.enable');
      // Test-only failure injection in the content world's media method. Normal flows
      // use the unmodified real media element; this covers a rejected browser play().
      app.rejectResume = async reject => {
        const world = worlds.findLast(world => world.origin === `chrome-extension://${id}` || world.name.includes(id));
        expect(world, 'extension isolated world').toBeDefined();
        const result = await cdp.send('Runtime.evaluate', { contextId: world!.id, expression: reject
          ? `globalThis.fixturePlay = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function() { return Promise.reject(new DOMException('Fixture autoplay denied', 'NotAllowedError')); };`
          : `HTMLMediaElement.prototype.play = globalThis.fixturePlay;` });
        expect(result.exceptionDetails).toBeUndefined();
      };
      let html = await readFile(new URL('./watch.html', import.meta.url), 'utf8');
      if (delayedPlayer) {
        // Hold the actual MediaStream until the test observes the bind deadline.
        html = html.replace('video.srcObject = canvas.captureStream(25);',
          'window.readyFixtureMedia = () => { video.srcObject = canvas.captureStream(25); };');
      }
      if (plan) {
        // The live canvas supplies a real playback clock; give this synthetic
        // lesson a finite timeline and a native-bar anchor for rail geometry.
        html = html.replace('</style>', '#movie_player { position: relative; } .ytp-progress-bar { position:absolute; bottom:8px; left:12px; right:12px; height:4px; }</style>')
          .replace('</video>', '</video><div class="ytp-progress-bar"></div>');
      }
      await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      app.page = page;
      await page.goto(plan ? `https://www.youtube.com/watch?v=${plan.videoId}` : preparedVideo ? watchUrl : 'https://www.youtube.com/watch?v=unknown0001');
      if (plan) {
        await expect(page.locator('.breakpoint-shell')).toBeAttached();
        const world = worlds.findLast(world => world.origin === `chrome-extension://${id}` || world.name.includes(id));
        expect(world, 'extension isolated world').toBeDefined();
        const result = await cdp.send('Runtime.evaluate', { contextId: world!.id, expression:
          `Object.defineProperty(document.querySelector('video'), 'duration', { get: () => 20 }); document.querySelector('video').dispatchEvent(new Event('durationchange'));` });
        expect(result.exceptionDetails).toBeUndefined();
      }
      else if (preparedVideo) await expect(page.getByRole('button', { name: new RegExp(`^Breakpoint · ${breakpointCount} challenge${breakpointCount === 1 ? '' : 's'}`) })).toBeVisible();
      else await expect(page.getByRole('button', { name: 'Test me', exact: true })).toBeEnabled();
      await use(app);
    } finally {
      releasePending();
      await context?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  },
});

export async function automaticPause(page: Page) {
  await page.locator('#start').click();
  await expect(page.locator('.bp-panel')).toBeVisible();
  const state = await page.locator('video').evaluate(video => ({ paused: video.paused, time: video.currentTime }));
  expect(state.paused).toBe(true);
  expect(state.time).toBeGreaterThanOrEqual(pauseAtS);
  expect(state.time).toBeLessThanOrEqual(pauseAtS + 0.5);
  await expect(page.getByRole('heading', { name: 'Raise a number to a power' })).toBeFocused();
}

export async function expectPlaying(page: Page) {
  await expect.poll(() => page.locator('video').evaluate(video => video.paused)).toBe(false);
  await expect(page.locator('.bp-panel')).toHaveCount(0);
}
