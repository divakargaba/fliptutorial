// Records the PRD §9 backup demo takes on real YouTube with Playwright recordVideo.
// Needs the local backend on 127.0.0.1:8000 and a built extension
// (extension/: npm run build). Run from the repo root:
//   node demo/record.mjs            # both takes
//   node demo/record.mjs exponent   # one take (exponent | calculator)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root, 'extension/package.json'));
const { chromium } = require('@playwright/test');
const extension = join(root, 'extension/.output/chrome-mv3');
const size = { width: 1440, height: 900 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const takes = {
  exponent: {
    start: 9797, pauseAtS: 9803.32, revealAtS: 9805.32,
    title: 'Raise a number to a power',
    header: 'def raise_to_power(base_num, pow_num):\n    ',
    wrong: 'return base_num * pow_num',
    right: 'result = 1\n    for index in range(pow_num):\n        result = result * base_num\n    return result\n',
  },
  calculator: {
    start: 3332, pauseAtS: 3338, revealAtS: 3340,
    title: 'Add two numbers',
    header: 'def add_numbers(a, b):\n    ',
    right: 'return a + b\n',
  },
};

const videoState = page => page.evaluate(() => {
  const v = document.querySelector('#movie_player video');
  const ad = document.querySelector('#movie_player')?.classList.contains('ad-showing') ?? false;
  return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState, ad } : null;
});

async function until(fn, timeoutMs, stepMs = 25) {
  const started = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return Date.now();
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await sleep(stepMs);
  }
}

async function typeCode(page, take, body) {
  const editor = page.getByRole('textbox', { name: 'Python code' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(take.header);
  // Type single lines visibly; paste multi-line bodies so editor auto-indent
  // cannot change the code.
  if (body.trim().includes('\n')) await page.keyboard.insertText(body);
  else await page.keyboard.type(body, { delay: 45 });
}

async function record(name) {
  const take = takes[name];
  const videoDir = mkdtempSync(join(tmpdir(), 'bp-demo-'));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: false, viewport: size,
    recordVideo: { dir: videoDir, size },
    args: ['--autoplay-policy=no-user-gesture-required',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const page = context.pages()[0] ?? await context.newPage();
  const out = { take: name };
  let saved;
  try {
    await page.goto(`https://www.youtube.com/watch?v=rfscVS0vtbw&t=${take.start}s`, { timeout: 60000 });
    await until(() => page.getByRole('button', { name: /^Breakpoint · / }).isVisible(), 30000);
    await until(async () => { const s = await videoState(page); return s && !s.ad && s.t > take.start - 1; }, 120000, 200);
    await until(() => page.locator('.bp-panel').isVisible(), 60000, 20);
    const paused = await videoState(page);
    out.pausedAtS = Number(paused.t.toFixed(3));
    out.pausedOk = paused.paused && paused.t >= take.pauseAtS && paused.t < take.revealAtS;
    await until(() => page.getByRole('heading', { name: take.title }).isVisible(), 5000);
    await sleep(2500);
    if (take.wrong) {
      await typeCode(page, take, take.wrong);
      await sleep(800);
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await until(() => page.getByText('Wrong answer').first().isVisible(), 20000);
      out.stillPausedAfterWrong = (await videoState(page)).paused;
      await sleep(3000);
    }
    await typeCode(page, take, take.right);
    await sleep(1200);
    const submitted = Date.now();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await until(() => page.getByRole('heading', { name: 'Solved' }).isVisible(), 20000);
    out.submitToSolvedS = (Date.now() - submitted) / 1000;
    await until(async () => !(await videoState(page)).paused, 20000);
    out.submitToPlayingS = (Date.now() - submitted) / 1000;
    await until(async () => !(await page.locator('.bp-panel').isVisible()), 5000);
    out.badgeAfter = await page.locator('breakpoint-practice').evaluate(el =>
      el.shadowRoot?.querySelector('[data-breakpoint-badge]')?.textContent?.trim());
    await sleep(4000);
    saved = join(root, `demo/${name}-challenge.webm`);
  } catch (error) {
    out.error = String(error);
  } finally {
    const video = page.video();
    await context.close();
    if (saved && video) renameSync(await video.path(), saved);
    rmSync(videoDir, { recursive: true, force: true });
  }
  out.file = saved ? `demo/${name}-challenge.webm` : null;
  console.log(JSON.stringify(out));
  return !out.error && out.pausedOk;
}

const chosen = process.argv.slice(2).filter(arg => arg in takes);
let ok = true;
for (const name of chosen.length ? chosen : Object.keys(takes)) ok = (await record(name)) && ok;
process.exit(ok ? 0 : 1);
