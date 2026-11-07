import './styles/youtube.css';
import '../src/ui/theme.css';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { browser } from 'wxt/browser';
import { createShadowRootUi, type ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root';
import { sendRequest } from '../src/api';
import { PracticeResponseSchema, SubmissionResponseSchema, type WorkerMessage } from '../src/contracts';
import { flushDraft, loadDraft, saveDraft } from '../src/drafts';
import { PlaybackSession, watchVideoId, type Ticket } from '../src/playback';
import { Badge } from '../src/ui/Badge';
import { PracticePanel } from '../src/ui/PracticePanel';

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  allFrames: false,
  cssInjectionMode: 'ui',
  main(ctx) {
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
      return null;
    };
    const mountable = () => !!ui?.shadowHost.isConnected && !uiFailed && !!findAnchor();
    const focusBadge = () => ui?.shadow.querySelector<HTMLButtonElement>('[data-breakpoint-badge] button')?.focus();
    const focusPanel = () => {
      const panel = ui?.shadow.querySelector<HTMLElement>('[data-breakpoint-panel]');
      (panel?.querySelector<HTMLElement>('h2[tabindex]') ?? panel)?.focus();
    };

    function render() {
      if (!ui?.mounted || !isCurrent() || uiFailed) return;
      const active = session.active;
      const state = bindExpired || session.route === 'unavailable' ? 'unavailable' : session.route === 'loading' ? 'loading' : 'ready';
      const count = session.data?.breakpoints.filter(b => !session.consumed.has(b.id)).length ?? 0;
      try {
        flushSync(() => ui!.mounted!.render(<div className="breakpoint-shell">
          {session.route !== 'unsupported' && <div data-breakpoint-badge>
            <Badge count={count} state={state} onOpen={openFromBadge} />
            {state === 'unavailable' && <button type="button" className="bp-button" onClick={openFromBadge}>Retry practice</button>}
          </div>}
          {active && session.videoId && <div data-breakpoint-panel tabIndex={-1}>
            <PracticePanel key={`${session.generation}/${active.breakpoint.exercise.id}`}
            videoId={session.videoId} revision={active.revision} breakpoint={active.breakpoint}
            attempt={active.state} result={active.result} error={active.error} canResume={active.canResume}
            onRun={code => void grade('run', code)} onSubmit={code => void grade('submit', code)}
            onSkip={skip} onClose={skip} onResume={() => void resume(session.ticket())} />
          </div>}
        </div>));
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
          session.reset(); nextAnchor.prepend(ui.shadowHost); anchor = nextAnchor;
        }
        return;
      }
      const generation = session.generation;
      mounting = true;
      try {
        const created = await createShadowRootUi(ctx, {
          name: 'breakpoint-practice', position: 'inline', anchor: nextAnchor, append: 'first', isolateEvents: true,
          onMount: container => createRoot(container, { onUncaughtError: failMount }),
          onRemove: root => root?.unmount(),
        });
        if (generation !== session.generation || !isCurrent()) { created.remove(); return; }
        ui = created; anchor = nextAnchor;
        ui.mount(); render();
      } catch { if (generation === session.generation) failMount(); }
      finally { if (generation === session.generation) mounting = false; }
    }

    async function lookup(refresh?: { ticket: Ticket; submittedCode: string }) {
      const generation = session.generation;
      const videoId = session.videoId;
      const sequence = ++lookupSequence;
      if (!videoId) return;
      if (!refresh) { session.route = 'loading'; render(); }
      const reply = await sendRequest({ type: 'lookup', videoId }, PracticeResponseSchema, send);
      if (generation !== session.generation || sequence !== lookupSequence || !isCurrent() ||
          (refresh && !session.isCurrent(refresh.ticket))) return;
      if (reply.ok && session.acceptLookup(generation, reply.data)) {
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
      if (!active || active.error?.code === 'EXERCISE_NOT_FOUND') return;
      const ticket = session.beginGrade();
      if (!ticket) return;
      render();
      const reply = await sendRequest({ type: 'grade', exerciseId: active.breakpoint.exercise.id, revision: active.revision, mode, code }, SubmissionResponseSchema, send);
      if (!isCurrent()) return;
      const action = session.finishGrade(ticket, mode, reply);
      if (action === 'ignored') return;
      if (!reply.ok && reply.error.error.code === 'STALE_EXERCISE') {
        session.active!.state = 'checking'; render(); await lookup({ ticket, submittedCode: code });
      } else {
        render();
        if (action === 'resume') await resume(ticket);
      }
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

    function skip() {
      const ticket = session.skip();
      if (ticket) { render(); void resume(ticket); }
    }

    function openFromBadge() {
      if (session.route === 'loading') return;
      if (session.route === 'unavailable' || bindExpired || uiFailed) {
        bindExpired = false; uiFailed = false; observePlayer(); void lookup(); return;
      }
      const video = player;
      if (session.active || !video || !playerReady || !isCurrent() || video !== currentPlayer() || isAd() || isFullscreen() || !mountable()) return;
      const breakpoint = session.data?.breakpoints.find(b => !session.consumed.has(b.id));
      if (!breakpoint) return;
      if (session.open(breakpoint, video.currentTime, !video.paused)) {
        video.pause(); render(); focusPanel();
      }
    }

    function sample() {
      const video = player;
      if (!video || !isCurrent() || video !== currentPlayer()) { session.reset(); return; }
      const ad = isAd();
      if (ad !== lastAd) { lastAd = ad; session.reset(); if (session.active) session.interrupt(); render(); }
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
      on('loadedmetadata', () => { playerReady = video.readyState >= 1; session.reset(); });
      on('canplay', () => {
        // canplay without a metadata/source change may belong to the previous route.
        if (video !== oldPlayer || (!!video.currentSrc && video.currentSrc !== oldSource)) playerReady = true;
        session.reset();
      });
      on('emptied', () => { playerReady = false; interrupt(); });
      on('seeking', interrupt);
      on('seeked', () => session.reset());
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
      session.navigate(id);
      if (!id) return;
      observePlayer(); void lookup();
    }

    ctx.addEventListener(document, 'yt-navigate-finish', routeChanged);
    ctx.addEventListener(document, 'visibilitychange', () => session.reset());
    ctx.addEventListener(document, 'fullscreenchange', () => { session.reset(); });
    ctx.addEventListener(window, 'resize', () => { session.reset(); void ensureUi(); });
    ctx.setInterval(() => {
      if (lastHref !== location.href) routeChanged();
      if (!session.videoId || !isCurrent()) return;
      if (!bindExpired && currentPlayer() !== player && !observer) observePlayer();
      if (observer) findPlayer();
      const ad = isAd();
      if (ad !== lastAd) { lastAd = ad; session.interrupt(); render(); }
      if (ui && !ui.shadowHost.isConnected) { session.reset(); void ensureUi(); }
    }, 250);
    ctx.onInvalidated(() => { stopPlayer(); observer?.disconnect(); ui?.remove(); session.navigate(null); });
    routeChanged();
  },
});
