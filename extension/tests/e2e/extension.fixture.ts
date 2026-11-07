import { test as base, chromium, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PracticeResponse } from '../../src/contracts';
const practice: PracticeResponse = JSON.parse(readFileSync(new URL('../../../contracts/practice-response.fixture.json', import.meta.url), 'utf8'));
const failed = JSON.parse(readFileSync(new URL('../../../contracts/submission-response.fixture.json', import.meta.url), 'utf8'));

export const watchUrl = 'https://www.youtube.com/watch?v=samplevid01';
export const pauseAtS = 1.2;
export const secondPauseAtS = 3.0;
export const secondTitle = 'Try a second exponent';
export const correctCode = 'def raise_to_power(base, exponent):\n    return base ** exponent';
type Submission = { exerciseId: string; revision: string; mode: 'run' | 'submit'; code: string };
type App = {
  page: Page;
  requests: Submission[];
  hold: boolean;
  unavailable: boolean;
  release(): Promise<void>;
  rejectResume(reject: boolean): Promise<void>;
};

export const test = base.extend<{ app: App; breakpointCount: 1 | 2 }>({
  breakpointCount: [1, { option: true }],
  app: async ({ viewport, breakpointCount }, use) => {
    const requests: Submission[] = [];
    const pending: Array<() => void> = [];
    const releasePending = () => pending.splice(0).forEach(fn => fn());
    const app = { requests, hold: false, unavailable: false } as App;
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
      if (req.method === 'GET' && req.url?.startsWith('/v1/videos/')) {
        const id = req.url.split('/')[3];
        json(200, id === practice.videoId ? {
          ...practice, breakpoints,
        } : { schemaVersion: 1, videoId: id, revision: null, status: 'unsupported', breakpoints: [] });
      } else if (req.method === 'POST' && req.url === '/v1/submissions') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const submission = JSON.parse(body) as Submission;
        requests.push(submission);
        const respond = () => {
          if (app.unavailable) {
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
        const downloaded = context.waitForEvent('requestfinished', request => request.url() === `${api.origin}/v1/submissions`);
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
      const html = await readFile(new URL('./watch.html', import.meta.url), 'utf8');
      await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      app.page = page;
      await page.goto(watchUrl);
      await expect(page.getByRole('button', { name: `Breakpoint · ${breakpointCount} exercise${breakpointCount === 1 ? '' : 's'}` })).toBeVisible();
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
