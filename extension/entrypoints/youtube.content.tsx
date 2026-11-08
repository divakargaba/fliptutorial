import shellCss from './styles/youtube.css?inline';
import themeCss from '../src/ui/theme.css?inline';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { browser } from 'wxt/browser';
import { createShadowRootUi, type ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root';
import { sendRequest } from '../src/api';
import { PracticeResponseSchema, SubmissionResponseSchema, TestMeResponseSchema, type WorkerMessage } from '../src/contracts';
import { flushDraft, loadDraft, saveDraft } from '../src/drafts';
import { listSolved, markSolved } from '../src/progress';
import { PlaybackSession, watchVideoId, type Ticket } from '../src/playback';
import { TestMeContext } from '../src/test-me';
import { Badge } from '../src/ui/Badge';
import { TestMeControls } from '../src/ui/TestMeControls';
import { PracticePanel, SOLVED_HOLD_MS, type PracticePanelProps } from '../src/ui/PracticePanel';

type RenderedPanel = PracticePanelProps & { aiGenerated: boolean };

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  allFrames: false,
  // Start lookup and player observation as soon as the DOM exists. YouTube's
  // document_idle can lag playable media by several seconds on a fresh profile.
  runAt: 'document_end',
  // Bundle shadow styles with the UI to avoid a cold extension-resource fetch.
  // WXT still owns isolation, mounting and cleanup; no styles reach YouTube.
  cssInjectionMode: 'manual',
  main(ctx) {
    const testMeEnabled = import.meta.env.WXT_TESTME_ENABLED === 'true';
    const debug = new URL(location.href).searchParams.has('breakpoint-debug');
    const trace = (stage: string) => { if (debug) performance.mark(`breakpoint:${stage}`); };
    trace('start');
    const session = new PlaybackSession();
    let player: HTMLVideoElement | null = null;
    let oldPlayer: HTMLVideoElement | null = null;
    let oldSource = '';
    let playerReady = false;
    let stopPlayer = () => {};
    let observer: MutationObserver | undefined;
    let bindDeadline = 0;
    let bindExpired = false;
    let ui: ShadowRootContentScriptUi<Root> | undefined;
    let mounting = false;
    let uiFailed = false;
    let anchor: Element | null = null;
    let lastAd = false;
    let lookupSequence = 0;
    let lastHref = '';
    // A passed attempt lingers on its solved moment briefly before playback resumes.
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    // The last rendered panel, kept mounted for its exit animation after the attempt ends.
    let shownPanel: RenderedPanel | null = null;
    let leavingPanel: RenderedPanel | null = null;
    let leavingTimer: ReturnType<typeof setTimeout> | undefined;
    const noop = () => {};
    const theme = () => document.documentElement.hasAttribute('dark') ? 'dark' : 'light';

    const currentPlayer = () => document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video')
      ?? document.querySelector<HTMLVideoElement>('#movie_player video');
    const isAd = () => !!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting');
    const isFullscreen = () => !!document.fullscreenElement || !!document.querySelector('#movie_player.ytp-fullscreen');
    const isCurrent = () => ctx.isValid && watchVideoId(location.href) === session.videoId;
    const send = (message: WorkerMessage) => browser.runtime.sendMessage(message);
    const findAnchor = (): Element | null => {
      const theater = document.querySelector('ytd-watch-flexy[theater]');
      const secondary = document.querySelector('#secondary-inner, #secondary');
      if (!theater && secondary && secondary.getBoundingClientRect().width >= 360) return secondary;
      const below = document.querySelector('#below');
      if (below && below.getBoundingClientRect().width > 0) return below;
      // YouTube hydrates #below and the right column after media is playable.
      // Its primary column already provides a safe in-flow slot after the player.
      const primary = document.querySelector('#primary-inner');
      if (primary && primary.getBoundingClientRect().width > 0 && primary.contains(currentPlayer())) return primary;
      const initialPlayer = document.querySelector('#player');
      if (initialPlayer?.parentElement === document.body && initialPlayer.contains(currentPlayer())) return initialPlayer;
      return null;
    };
    const placeUi = (target: Element, host: Element) => {
      if (target.id === 'player') target.after(host);
      else if (target.id === 'primary-inner') target.append(host);
      else target.prepend(host);
    };
    // The transient body-level player is sufficient for a badge, but wait for
    // the watch layout before offering a panel or claiming an automatic pause.
    const mountable = () => {
      if (!ui?.shadowHost.isConnected || uiFailed) return false;
      const target = findAnchor();
      return !!target && target.id !== 'player' && ui.shadowHost.parentElement === target;
    };
    const testMePlayer = () => {
      const video = player;
      return video && playerReady && isCurrent() && video === currentPlayer() && !video.seeking && !video.ended &&
        !isAd() && !isFullscreen() && mountable() ? video : null;
    };
    const focusBadge = () => ui?.shadow.querySelector<HTMLElement>('[data-breakpoint-badge] .bp-badge')?.focus({ preventScroll: true });
    const focusPanel = () => {
      const panel = ui?.shadow.querySelector<HTMLElement>('[data-breakpoint-panel]');
      (panel?.querySelector<HTMLElement>('h2[tabindex]') ?? panel)?.focus();
    };

    function render() {
      if (!ui?.mounted || !isCurrent() || uiFailed) return;
      const active = session.active;
      const state = bindExpired || session.route === 'unavailable' ? 'unavailable' : session.route === 'loading' ? 'loading' : 'ready';
      const breakpoints = session.data?.breakpoints ?? [];
      const remaining = breakpoints.filter(b => session.available(b));
      const solved = breakpoints.filter(b => session.solvedIds.has(b.exercise.id)).length;
      let panel: RenderedPanel | null = null;
      if (active && session.videoId) {
        panel = {
          videoId: session.videoId, revision: active.revision, breakpoint: active.breakpoint,
          attempt: active.state, result: active.result, error: active.error, canResume: active.canResume,
          aiGenerated: active.generated,
          ...(active.generated ? {} : {
            index: Math.max(0, breakpoints.findIndex(b => b.id === active.breakpoint.id)), total: breakpoints.length,
          }),
          holdMs: SOLVED_HOLD_MS,
          onRun: code => void grade('run', code), onSubmit: code => void grade('submit', code),
          onSkip: skip, onClose: skip, onResume: resumeNow,
        };
        clearTimeout(leavingTimer); leavingPanel = null;
      } else if (shownPanel) {
        // Keep the finished panel mounted, inert, for its exit animation.
        leavingPanel = { ...shownPanel, leaving: true, onRun: noop, onSubmit: noop, onSkip: noop, onResume: noop, onClose: noop };
        clearTimeout(leavingTimer);
        leavingTimer = setTimeout(() => { leavingPanel = null; render(); }, 220);
      }
      shownPanel = panel;
      const visiblePanel = panel ?? leavingPanel;
      const request = session.testMe;
      const testMe = testMeEnabled ? {
        canStart: !active && !request && document.visibilityState === 'visible' && !!testMePlayer(),
        request: request ? (request.error ? { status: 'error' as const, error: request.error } : { status: 'loading' as const }) : null,
        aiGenerated: !!visiblePanel?.aiGenerated,
        onStart: startTestMe, onRetry: retryTestMe, onClose: closeTestMe,
      } : null;
      try {
        flushSync(() => ui!.mounted!.render(<TestMeContext.Provider value={testMe}><div className="breakpoint-shell" data-theme={theme()}
          data-placement={anchor?.id === 'secondary-inner' || anchor?.id === 'secondary' ? 'side' : 'below'}>
          {session.route !== 'unsupported' && <div data-breakpoint-badge>
            <Badge state={state} total={breakpoints.length} remaining={remaining.length} solved={solved}
              active={!!active && !active.generated} nextAtS={remaining[0]?.pauseAtS ?? null} onOpen={openFromBadge} />
          </div>}
          <TestMeControls />
          {visiblePanel && <div data-breakpoint-panel data-ai-generated={visiblePanel.aiGenerated || undefined} tabIndex={-1} style={{ width: '100%' }}>
            <PracticePanel key={`${session.generation}/${visiblePanel.breakpoint.exercise.id}`} {...visiblePanel} />
          </div>}
        </div></TestMeContext.Provider>));
      } catch { failMount(); }
    }

    function failMount() {
      if (uiFailed) return;
      uiFailed = true;
      const video = player;
      const ticket = session.ticket();
      const ownsPause = video && isCurrent() && currentPlayer() === video && !isAd() && !isFullscreen() &&
        session.canResume(ticket, video.currentTime, video.paused);
      session.releaseFailedMount();
      // A failed renderer must never trap the player. Native controls remain reachable if play rejects.
      if (ownsPause) void video.play().catch(() => video.focus());
      queueMicrotask(() => { ui?.remove(); ui = undefined; });
    }

    async function ensureUi() {
      const nextAnchor = findAnchor();
      if (!nextAnchor || mounting || uiFailed || !session.videoId) return;
      if (ui) {
        if (anchor !== nextAnchor || !ui.shadowHost.isConnected) {
          session.reset(); placeUi(nextAnchor, ui.shadowHost); anchor = nextAnchor; render();
        }
        return;
      }
      const generation = session.generation;
      mounting = true;
      trace('mount-start');
      try {
        const created = await createShadowRootUi(ctx, {
          name: 'breakpoint-practice', position: 'inline', anchor: nextAnchor, append: placeUi, isolateEvents: true,
          css: `${shellCss}\n${themeCss}`,
          onMount: container => createRoot(container, { onUncaughtError: failMount }),
          onRemove: root => root?.unmount(),
        });
        if (generation !== session.generation || !isCurrent()) { created.remove(); return; }
        ui = created; anchor = nextAnchor;
        ui.mount(); render(); trace('mounted');
      } catch { if (generation === session.generation) failMount(); }
      finally { if (generation === session.generation) mounting = false; }
    }

    async function lookup(refresh?: { ticket: Ticket; submittedCode: string }) {
      const generation = session.generation;
      const videoId = session.videoId;
      const sequence = ++lookupSequence;
      if (!videoId) return;
      if (!refresh) { session.route = 'loading'; render(); }
      trace('lookup-start');
      const reply = await sendRequest({ type: 'lookup', videoId }, PracticeResponseSchema, send);
      trace('lookup-end');
      trace(reply.ok ? 'lookup-valid' : `lookup-error:${reply.error.error.code}`);
      const solvedIds = reply.ok && reply.data.status === 'ready'
        ? await listSolved(videoId, reply.data.revision).catch(() => new Set<string>())
        : new Set<string>();
      if (generation !== session.generation || sequence !== lookupSequence || !isCurrent() ||
          (refresh && !session.isCurrent(refresh.ticket))) return;
      if (reply.ok && session.acceptLookup(generation, reply.data, solvedIds)) {
        if (refresh && session.active) {
          const updated = reply.data.breakpoints.find(b => b.exercise.id === session.active!.breakpoint.exercise.id);
          if (updated && reply.data.revision) {
            const active = session.active;
            const draftPrefix = `${videoId}/${updated.exercise.id}/`;
            if (active.revision !== reply.data.revision) {
              const oldKey = draftPrefix + active.revision;
              const newKey = draftPrefix + reply.data.revision;
              try {
                await flushDraft(oldKey);
                const draft = await loadDraft(oldKey);
                if (!isCurrent() || !session.isCurrent(refresh.ticket)) return;
                saveDraft(newKey, draft ?? refresh.submittedCode);
                await flushDraft(newKey);
              } catch { /* The original draft stays under its original revision. */ }
              if (!isCurrent() || !session.isCurrent(refresh.ticket)) return;
            }
            session.consumed.add(updated.id);
            active.breakpoint = updated;
            active.revision = reply.data.revision;
            active.state = 'failed';
            active.error = { code: 'STALE_EXERCISE', message: 'The exercise was updated. Review it and submit again.', retryable: true };
          } else {
            session.active.state = 'failed';
            session.active.error = { code: 'EXERCISE_NOT_FOUND', message: 'This exercise is no longer available. Skip to resume the video.', retryable: false };
          }
        }
      } else {
        session.route = 'unavailable'; session.reset();
        if (refresh && session.active) { session.active.state = 'failed'; }
      }
      render();
    }

    async function grade(mode: 'run' | 'submit', code: string) {
      const active = session.active;
      const videoId = session.videoId;
      if (!videoId || !active || active.error?.code === 'EXERCISE_NOT_FOUND' || active.error?.code === 'SET_EXPIRED') return;
      const ticket = session.beginGrade();
      if (!ticket) return;
      render();
      const reply = await sendRequest({ type: 'grade', exerciseId: active.breakpoint.exercise.id, revision: active.revision, mode, code }, SubmissionResponseSchema, send);
      if (!isCurrent()) return;
      const action = session.finishGrade(ticket, mode, reply);
      if (action === 'ignored') return;
      if (!active.generated && !reply.ok && reply.error.error.code === 'STALE_EXERCISE') {
        session.active!.state = 'checking'; render(); await lookup({ ticket, submittedCode: code });
      } else {
        render();
        if (!active.generated && mode === 'submit' && active.state === 'passed') {
          await markSolved(videoId, active.breakpoint.exercise.id, active.revision).catch(() => {});
        }
        if (action === 'resume') {
          clearTimeout(holdTimer);
          holdTimer = setTimeout(() => { holdTimer = undefined; void resume(ticket); }, SOLVED_HOLD_MS);
        }
      }
    }

    function startTestMe() {
      if (!testMeEnabled || document.visibilityState !== 'visible') return;
      const video = testMePlayer();
      if (!video) return;
      const ticket = session.startTestMe(video.currentTime, !video.paused);
      if (!ticket) return;
      video.pause();
      render();
      void loadTestMe(ticket, video);
    }

    function retryTestMe() {
      const video = testMePlayer();
      const request = session.testMe;
      if (!video?.paused || !request || Math.abs(video.currentTime - request.pausedAt) >= 0.25) return;
      const ticket = session.retryTestMe();
      if (!ticket) return;
      render();
      void loadTestMe(ticket, video);
    }

    async function loadTestMe(ticket: Ticket, video: HTMLVideoElement) {
      const videoId = session.videoId;
      const request = session.testMe;
      if (!videoId || !request) return;
      const source = video.currentSrc;
      const reply = await sendRequest({ type: 'testMe', videoId, timestampS: request.pausedAt }, TestMeResponseSchema, send);
      if (!session.isTestMeCurrent(ticket)) return;
      if (video.currentSrc !== source) { session.interrupt(); render(); return; }
      if (testMePlayer() !== video || !video.paused ||
          Math.abs(video.currentTime - request.pausedAt) >= 0.25) {
        closeTestMe(); return;
      }
      if (session.finishTestMe(ticket, reply)) {
        render();
        if (reply.ok && document.visibilityState === 'visible') focusPanel();
      }
    }

    function closeTestMe() {
      if (!session.testMe) return;
      const video = player;
      const ownsPause = video && isCurrent() && currentPlayer() === video && !video.seeking && !isAd() && !isFullscreen() &&
        session.canResume(session.ticket(), video.currentTime, video.paused);
      session.interrupt();
      render();
      if (ownsPause) void video.play().catch(() => video.focus());
    }

    async function resume(ticket: Ticket) {
      const video = player;
      if (!video || !isCurrent() || video !== currentPlayer() || isAd() || isFullscreen() ||
          !session.canResume(ticket, video.currentTime, video.paused)) {
        if (session.isCurrent(ticket)) { session.interrupt(); render(); focusBadge(); }
        return;
      }
      try {
        await video.play();
        if (session.isCurrent(ticket)) { session.interrupt(); render(); }
        if (ticket.generation === session.generation) focusBadge();
      } catch {
        if (session.isCurrent(ticket)) {
          session.resumeRejected(ticket); render(); focusPanel();
        }
      }
    }

    function resumeNow() {
      clearTimeout(holdTimer); holdTimer = undefined;
      void resume(session.ticket());
    }

    function skip() {
      clearTimeout(holdTimer); holdTimer = undefined;
      const ticket = session.skip();
      if (ticket) { render(); void resume(ticket); }
    }

    function openFromBadge() {
      if (session.route === 'loading') return;
      if (session.route === 'unavailable' || bindExpired || uiFailed) {
        bindExpired = false; uiFailed = false; observePlayer(); void lookup(); return;
      }
      const video = player;
      if (session.active || session.testMe || !video || !playerReady || !isCurrent() || video !== currentPlayer() || isAd() || isFullscreen() || !mountable()) return;
      const breakpoint = session.data?.breakpoints.find(b => session.available(b));
      if (!breakpoint) return;
      if (session.open(breakpoint, video.currentTime, !video.paused)) {
        video.pause(); render(); focusPanel();
      }
    }

    function sample() {
      const video = player;
      if (!video || !isCurrent() || video !== currentPlayer()) { session.reset(); return; }
      const ad = isAd();
      if (ad !== lastAd) { lastAd = ad; session.reset(); if (session.active || session.testMe) session.interrupt(); render(); }
      const claimed = session.sample({ time: video.currentTime, wallMs: performance.now(), rate: video.playbackRate,
        playing: !video.paused && !video.ended, visible: document.visibilityState === 'visible',
        ad, fullscreen: isFullscreen(), seeking: video.seeking, mountable: mountable(), ready: playerReady });
      if (!claimed) return;
      // Read the actual player again after the synchronous claim, immediately before pausing.
      if (video !== currentPlayer() || isAd() || isFullscreen() || video.seeking || video.paused ||
          document.visibilityState !== 'visible' || !mountable() || video.currentTime < claimed.pauseAtS || video.currentTime >= claimed.revealAtS) {
        session.releaseFailedMount(); return;
      }
      session.active!.pausedAt = video.currentTime;
      video.pause(); render(); focusPanel();
    }

    function bind(video: HTMLVideoElement) {
      stopPlayer();
      session.interrupt(); player = video; session.reset();
      // YouTube can reuse the same element across routes. Wait for new media readiness in that case.
      playerReady = video.readyState >= 2 && (video !== oldPlayer || (!!video.currentSrc && video.currentSrc !== oldSource));
      lastAd = isAd();
      const controller = new AbortController();
      const on = (name: string, listener: EventListener) => video.addEventListener(name, listener, { signal: controller.signal });
      const interrupt = () => { session.interrupt(); render(); };
      on('loadedmetadata', () => { playerReady = video.readyState >= 1; session.reset(); if (testMeEnabled) render(); });
      on('canplay', () => {
        // canplay without a metadata/source change may belong to the previous route.
        if (video !== oldPlayer || (!!video.currentSrc && video.currentSrc !== oldSource)) playerReady = true;
        session.reset(); if (testMeEnabled) render();
      });
      on('emptied', () => { playerReady = false; interrupt(); });
      on('seeking', interrupt);
      on('seeked', () => { session.reset(); if (testMeEnabled) render(); });
      if (testMeEnabled) on('ended', render);
      on('ratechange', () => session.reset());
      on('play', interrupt);
      on('pause', () => session.reset());
      on('timeupdate', sample);
      let frame: number | undefined;
      if (typeof video.requestVideoFrameCallback === 'function') {
        const tick: VideoFrameRequestCallback = () => {
          if (controller.signal.aborted) return;
          sample(); frame = video.requestVideoFrameCallback(tick);
        };
        frame = video.requestVideoFrameCallback(tick);
      }
      stopPlayer = () => {
        controller.abort();
        if (frame !== undefined) video.cancelVideoFrameCallback(frame);
      };
      render();
    }

    function findPlayer() {
      if (!isCurrent() || !session.videoId || bindExpired) return;
      const video = currentPlayer();
      if (video && video !== player) bind(video);
      if (player && !player.isConnected) { stopPlayer(); player = null; playerReady = false; session.interrupt(); render(); }
      void ensureUi();
      if (performance.now() >= bindDeadline) {
        observer?.disconnect(); observer = undefined;
        if (!player || !playerReady || !mountable()) { bindExpired = true; session.reset(); render(); }
      }
    }

    function observePlayer() {
      observer?.disconnect(); bindDeadline = performance.now() + 5000;
      observer = new MutationObserver(findPlayer);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      findPlayer();
    }

    function routeChanged() {
      const id = watchVideoId(location.href);
      lastHref = location.href;
      if (session.generation && id === session.videoId) return;
      oldPlayer = player; oldSource = player?.currentSrc ?? '';
      stopPlayer(); observer?.disconnect(); observer = undefined;
      player = null; playerReady = false;
      ui?.remove(); ui = undefined; mounting = false; anchor = null; uiFailed = false; bindExpired = false;
      clearTimeout(holdTimer); holdTimer = undefined;
      clearTimeout(leavingTimer); leavingPanel = null; shownPanel = null;
      session.navigate(id);
      if (!id) return;
      observePlayer(); void lookup();
    }

    ctx.addEventListener(document, 'yt-navigate-finish', routeChanged);
    ctx.addEventListener(document, 'visibilitychange', () => { session.reset(); if (testMeEnabled) render(); });
    ctx.addEventListener(document, 'fullscreenchange', () => {
      session.reset();
      if (isFullscreen()) closeTestMe();
      if (testMeEnabled) render();
    });
    ctx.addEventListener(window, 'resize', () => { session.reset(); void ensureUi(); });
    ctx.setInterval(() => {
      if (lastHref !== location.href) routeChanged();
      if (!session.videoId || !isCurrent()) return;
      if (!bindExpired && currentPlayer() !== player && !observer) observePlayer();
      if (observer) findPlayer();
      const ad = isAd();
      if (ad !== lastAd) { lastAd = ad; session.interrupt(); render(); }
      // Theater changes the anchor without necessarily resizing the window or
      // replacing the player, including after the initial observer expires.
      void ensureUi();
    }, 250);
    ctx.onInvalidated(() => { stopPlayer(); observer?.disconnect(); ui?.remove(); session.navigate(null); });
    routeChanged();
  },
});
