// Opt-in headed integration rehearsal. Requires the real backend on port 8000.
// Run from extension/: node tests/e2e/real-youtube.mjs
import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const extension = fileURLToPath(new URL('../../.output/chrome-mv3', import.meta.url));
const checks = process.argv.includes('--checks');
const controls = process.argv.includes('--controls');
const badgeName = /^Breakpoint · \d+ challenge/;
const correctCode = 'def raise_to_power(base, exponent):\n    return base ** exponent';

async function seek(page, time) {
  // A reload may serve a pre-roll using the same video element. Wait for the
  // tutorial duration before seeking; never try to seek the ad's short timeline.
  await page.waitForFunction(() => {
    const video = document.querySelector('#movie_player video');
    const player = document.querySelector('#movie_player');
    return document.querySelector('#below')?.getBoundingClientRect().width > 0 && video?.readyState >= 2 &&
      video.duration > 9807 && player.getVideoData?.().video_id === 'rfscVS0vtbw' &&
      [1, 2].includes(player.getPlayerState?.()) && !document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting');
  }, undefined, { timeout: 90000 });
  await page.locator('#movie_player').evaluate((player, time) => {
    player.seekTo(time, true);
    player.playVideo();
  }, time);
  try { await page.waitForFunction(time => {
    const video = document.querySelector('#movie_player video');
    return video && !video.seeking && Math.abs(video.currentTime - time) < 1;
  }, time, { timeout: 20000 }); } catch (error) {
    console.log('SEEK DIAGNOSTICS', await page.locator('#movie_player video').evaluate(v => ({ time: v.currentTime, seeking: v.seeking, paused: v.paused, ready: v.readyState, error: v.error?.message })), await page.locator('.bp-panel').count());
    throw error;
  }
}

async function realChecks(page, context) {
  const video = page.locator('#movie_player video');
  const panel = page.locator('.bp-panel');
  const editor = page.getByRole('textbox', { name: 'Python code' });
  // Cross the threshold by seeking; the badge must still permit manual practice.
  await seek(page, 9804.4);
  await expect.poll(() => video.evaluate(v => v.currentTime)).toBeGreaterThan(9806);
  await expect(panel).toHaveCount(0);
  await seek(page, 9790);
  // Playwright pins focus/visibility by default. Restore actual browser tab
  // visibility for this check instead of faking document.visibilityState.
  const pageCdp = await context.newCDPSession(page);
  await pageCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const other = await context.newPage();
  const otherCdp = await context.newCDPSession(other);
  await otherCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await other.goto('about:blank');
  await other.bringToFront();
  let hidden = true;
  try { await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden'); }
  catch { hidden = false; }
  if (hidden) {
    await expect.poll(() => video.evaluate(v => v.currentTime), { timeout: 20000 }).toBeGreaterThan(9805.5);
  } else {
    console.log('MANUAL REQUIRED: this desktop keeps both Chromium pages visible; tab crossing was not exercised.');
  }
  await page.bringToFront();
  if (hidden) await expect(panel).toHaveCount(0);
  await other.close();
  // Restore the normal Playwright focus setting for the subsequent keyboard
  // assertions; the tab result above still uses only actual page visibility.
  await pageCdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // The first rewind may already have crossed naturally while the desktop
  // refused to hide the page. That still proves re-arming after the first seek.
  if (!(await panel.count())) {
    if (!hidden) await seek(page, 9806);
    await seek(page, 9801);
    await expect(panel).toBeVisible({ timeout: 10000 });
  }
  const pause = await video.evaluate(v => v.currentTime);
  expect(pause).toBeGreaterThanOrEqual(9803.32);
  expect(pause).toBeLessThanOrEqual(9803.82);
  console.log(JSON.stringify({ seekAcross: 'passed', tabCrossing: hidden ? 'passed' : 'manual required', rewindRearms: 'passed', pause }));
  await expect(page.getByRole('heading', { name: 'Raise a number to a power' })).toBeFocused();
  await expect(editor).toBeVisible();
  await page.keyboard.press('Tab'); // Editor
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  const editingTime = await video.evaluate(v => v.currentTime);
  for (const key of ['Space', 'j', 'k', 'l', 'f']) {
    await page.keyboard.press(key);
    expect(await video.evaluate(v => v.paused)).toBe(true);
    expect(Math.abs(await video.evaluate(v => v.currentTime) - editingTime)).toBeLessThan(0.1);
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  }
  await expect(editor).toContainText('jklf');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('def raise_to_power(base, exponent):\n    return base * exponent');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Stuck? Get a hint' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Wrong answer', { exact: true })).toBeVisible({ timeout: 20000 });
  expect(await video.evaluate(v => v.paused)).toBe(true);
  // Theater must move the existing panel below the player without losing the draft.
  await page.locator('.ytp-size-button').click();
  await expect.poll(() => page.locator('breakpoint-practice').evaluate(el => el.parentElement?.id)).toBe('below');
  await expect(editor).toContainText('return base * exponent');
  const boxes = await page.evaluate(() => ({ panel: document.querySelector('breakpoint-practice').getBoundingClientRect().toJSON(), player: document.querySelector('#movie_player').getBoundingClientRect().toJSON() }));
  expect(boxes.panel.top).toBeGreaterThanOrEqual(boxes.player.bottom - 1);
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(correctCode);
  for (let tabs = 0; tabs < 12; tabs++) {
    await page.keyboard.press('Tab');
    if (await page.getByRole('button', { name: 'Submit', exact: true }).evaluate(el => el.getRootNode().activeElement === el)) break;
  }
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeFocused();
  const started = Date.now();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0, { timeout: 20000 });
  await expect.poll(() => video.evaluate(v => v.paused)).toBe(false);
  console.log(JSON.stringify({ keyboard: 'passed', seekAcross: 'passed', theater: 'passed', submitMs: Date.now() - started }));

  const ads = await page.evaluate(() => window.bpAds);
  expect(ads.panelDuringAd).toBe(false);
  console.log(JSON.stringify({ ads }));
}

async function keyboardControl(page, close) {
  const video = page.locator('#movie_player video');
  const panel = page.locator('.bp-panel');
  await seek(page, 9806);
  await page.getByRole('button', { name: badgeName, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.bp-panel h2')).toBeFocused();
  if (close) await page.keyboard.press('Shift+Tab');
  else {
    const editor = page.getByRole('textbox', { name: 'Python code' });
    await expect(editor).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(editor).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Stuck? Get a hint' })).toBeFocused();
    await page.keyboard.press('Tab');
  }
  await expect(page.getByRole('button', { name: close ? 'Close practice' : 'More', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  if (!close) {
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Practice later', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(panel).toHaveCount(0);
  await expect.poll(() => video.evaluate(v => v.paused)).toBe(false);
  console.log(JSON.stringify({ keyboardControl: close ? 'close' : 'skip', result: 'passed' }));
}

for (let run = 1; run <= (checks ? 1 : controls ? 2 : 3); run++) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: false, viewport: { width: 1440, height: 900 },
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Extensions.loadUnpacked', { path: extension });
    const page = context.pages()[0];
    page.on('pageerror', error => console.log('PAGE ERROR', error.message));
    await page.addInitScript(() => {
      window.bpTiming = {};
      window.bpAds = { observed: false, panelDuringAd: false };
      setInterval(() => {
        const video = document.querySelector('#movie_player video');
        if (document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting')) {
          window.bpAds.observed = true;
          if (document.querySelector('breakpoint-practice')?.shadowRoot?.querySelector('.bp-panel')) window.bpAds.panelDuringAd = true;
        }
        if (video?.readyState >= 2 && !window.bpTiming.player) window.bpTiming.player = performance.now();
        const badge = document.querySelector('breakpoint-practice')?.shadowRoot?.querySelector('[data-breakpoint-badge] button');
        if (badge?.dataset.state === 'ready' && badge.getAttribute('aria-disabled') !== 'true' && !window.bpTiming.badge) {
          const rect = badge.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight) {
            window.bpTiming.badge = performance.now();
            window.bpTiming.badgeBox = rect.toJSON();
          }
        }
      }, 10);
    });
    await page.goto('https://www.youtube.com/watch?v=rfscVS0vtbw&t=9790s&breakpoint-debug=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await expect(page.getByRole('button', { name: badgeName })).toBeVisible({ timeout: 20000 });
    } catch {
      console.log('DIAGNOSTICS', await page.evaluate(() => ({ timing: window.bpTiming, stages: performance.getEntriesByType('mark').filter(m => m.name.startsWith('breakpoint:')).map(m => ({ name: m.name, time: m.startTime })), ui: document.querySelector('breakpoint-practice')?.shadowRoot?.querySelector('[data-breakpoint-badge]')?.textContent, video: document.querySelector('video')?.readyState, error: document.querySelector('.ytp-error-content-wrap')?.textContent })));
      throw new Error('Prepared badge unavailable on real YouTube');
    }
    await page.waitForFunction(() => window.bpTiming.player && window.bpTiming.badge, undefined, { timeout: 20000 });
    const timing = await page.evaluate(() => ({ ...window.bpTiming,
      dom: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
      stages: performance.getEntriesByType('mark').filter(r => r.name.startsWith('breakpoint:')).map(r => ({ name: r.name, time: r.startTime })),
    }));
    const badgeAfterPlayerMs = Math.max(0, timing.badge - timing.player);
    console.log(JSON.stringify({ run, badgeAfterPlayerMs, timing }));
    expect(badgeAfterPlayerMs, 'badge in viewport after playable media').toBeLessThanOrEqual(2000);
    if (checks) await realChecks(page, context);
    if (controls) await keyboardControl(page, run === 1);
  } finally { await context.close(); }
}
