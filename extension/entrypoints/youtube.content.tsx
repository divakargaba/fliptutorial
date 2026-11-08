import shellCss from './styles/youtube.css?inline';
import timelineCss from './styles/timeline.css?inline';
import themeCss from '../src/ui/theme.css?inline';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { browser } from 'wxt/browser';
import { createShadowRootUi, type ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root';
import { sendRequest } from '../src/api';
import { PracticeResponseSchema, SubmissionResponseSchema, TestMeResponseSchema, type WorkerMessage, HintResponseSchema, AnalysisResponseSchema } from '../src/contracts';
import { flushDraft, loadDraft, saveDraft } from '../src/drafts';
import { listSolved, markSolved } from '../src/progress';
import { PlaybackSession, watchVideoId, type Ticket } from '../src/playback';
import { TestMeContext } from '../src/test-me';
import { Badge } from '../src/ui/Badge';
import { WorkspaceContext } from '../src/ui/workspace';
import { PRACTICE_LAYOUT_KEY, readPracticeLayout, savePracticeLayout, type PracticeLayout } from '../src/ui/workspace-preference';
import { TestMeControls } from '../src/ui/TestMeControls';
import { PracticePanel, SOLVED_HOLD_MS, type PracticePanelProps } from '../src/ui/PracticePanel';
import { HintsContext, type AnalysisState } from '../src/hints';
import { sendPlanRequest, AwardResultSchema, LevelResultSchema, LevelsResultSchema } from '../src/plan/api';
import { AnswerResultSchema, ExercisePlanSchema, RefresherSchema, SubmitResultSchema, type PlanMessage, type Refresher } from '../src/plan/schemas';
import { ACCOUNT_KEY, SETTINGS_KEY, readAccount, readSettings, type LearnerSettings } from '../src/plan/settings';
import { EventQueue } from '../src/plan/events';
import { WatchSegments } from '../src/plan/watch';
import { PlanLoader } from '../src/plan/loader';
import { planSolved, markPlanSolved } from '../src/plan/progress';
import type { ExercisePlan, FeedbackResult, PracticeEvent } from '../src/v2/types';
import { ConceptQuestionPanel, TopicNotAvailable, TimelineMarkers, RefresherPrompt, type Award } from '../src/ui/v2';
import { saveLearnerSettings } from '../src/plan/preferences';
import { seekForPractice } from '../src/plan/timeline';

// Keep the presentation contract shared with B2. accountId is wired ahead of
// its draft-isolation follow-up; feedback uses the exact submitted snapshot.
type RenderedPanel = PracticePanelProps & { aiGenerated: boolean; accountId?: string;
  language?: PracticePanelProps['breakpoint']['exercise']['language'] };

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
    let plan: ExercisePlan | null = null;
    let planSolvedIds = new Set<string>();
    let prepared: boolean | null = null;
    let settings: LearnerSettings = readSettings({}); // disabled until storage has loaded
    let accountId = 'test-ana';
    let accountReady = false;
    let planLoader: PlanLoader | undefined;
    let planLoadSequence = 0;
    let dismissedUnavailable = false;
    let layout: PracticeLayout = 'below';
    let layoutSaving = false;
    let layoutError: string | null = null;
    let feedbackState: { ticket: Ticket; feedback: FeedbackResult; code: string } | null = null;
    // What the latest pass / correct answer earned (B1 award endpoint), shown as a progress card.
    let progressState: { ticket: Ticket; award: Award } | null = null;
    let refresher: Refresher | null = null;
    let refresherSequence = 0;
    const attemptEvents = new WeakMap<object, { accountId: string; attempts: number; hintsUsed: number }>();
    // Content persists events directly, so navigation or worker cold-start cannot
    // lose them before delivery. The worker is the sole network queue drainer.
    const eventStore = new EventQueue(browser.storage.local, async () => false);
    function emitEvent(fields: Omit<PracticeEvent, 'id' | 'at' | 'accountId'>, account = accountId): string {
      const event = { ...fields, accountId: account, id: crypto.randomUUID(), at: new Date().toISOString() };
      void eventStore.enqueue([event]).then(() => browser.runtime.sendMessage({ type: 'flushEventsV2' })).catch(() => {});
      return event.id;
    }
    const watch = new WatchSegments(watchedS => {
      if (session.videoId) emitEvent({ type: 'watched', videoId: session.videoId, watchedS });
    });
    function eventContext(active = session.active) {
      if (!active) return null;
      let context = attemptEvents.get(active);
      if (!context) { context = { accountId, attempts: 0, hintsUsed: 0 }; attemptEvents.set(active, context); }
      return context;
    }
    function practiceEvent(type: PracticeEvent['type'], active = session.active, extra: Partial<PracticeEvent> = {}): string | undefined {
      const item = active?.planPause?.exercise ?? active?.planPause?.question;
      const context = eventContext(active);
      if (!active || active.reviewOnly || active.refresher || !item || !context || !session.videoId) return;
      return emitEvent({ type, videoId: session.videoId, exerciseId: item.id, concepts: item.concepts, level: item.level,
        attempts: context.attempts, hintsUsed: context.hintsUsed, ...extra }, context.accountId);
    }
    const sendV2 = (message: PlanMessage) => browser.runtime.sendMessage(message);
    async function learnerLevel(concept: string | undefined, account: string): Promise<string> {
      if (!concept) return 'beginner-1';
      const reply = await sendPlanRequest({ type: 'levelV2', accountId: account, concept }, LevelResultSchema, sendV2);
      return reply.ok ? reply.data.level : 'beginner-1';
    }
    /** Show what a delivered event earned. The event queue flushes asynchronously, so the award
     * endpoint answers EVENT_NOT_FOUND until the event is stored: retry briefly, then give up quietly. */
    async function showProgress(ticket: Ticket, account: string, eventId: string) {
      for (let attempt = 0; attempt < 15; attempt++) {
        const reply = await sendPlanRequest({ type: 'awardV2', accountId: account, eventId }, AwardResultSchema, sendV2);
        if (!isCurrent() || !session.isCurrent(ticket)) return;
        if (reply.ok) {
          if (reply.data.awards.length) { progressState = { ticket, award: reply.data }; render(); }
          return;
        }
        if (!['EVENT_NOT_FOUND', 'NETWORK', 'TIMEOUT'].includes(reply.error.error.code)) return;
        await new Promise(resolve => setTimeout(resolve, 400));
        if (!isCurrent() || !session.isCurrent(ticket)) return;
      }
    }
    let player: HTMLVideoElement | null = null;
    let oldPlayer: HTMLVideoElement | null = null;
    let oldSource = '';
    let playerReady = false;
    let stopPlayer = () => {};
    let observer: MutationObserver | undefined;
    let bindDeadline = 0;
    let bindExpired = false;
    let ui: ShadowRootContentScriptUi<Root> | undefined;
    let timelineUi: ShadowRootContentScriptUi<Root> | undefined;
    let timelineMounting = false;
    let timelineSignature = '';
    let timelineSelection: AbortController | undefined;
    let mounting = false;
    let uiFailed = false;
    let anchor: Element | null = null;
    let lastAd = false;
    let lookupSequence = 0;
    let lastHref = '';
    // A passed attempt lingers on its solved moment briefly before playback resumes.
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    // Efficiency review of the latest passing submission, keyed to its attempt.
    let analysisState: { ticket: Ticket; state: AnalysisState } | null = null;
    const hints = {
      async requestHint(input: { code: string; level: number; lastResult?: unknown; previousHints?: string[] }) {
        const a = session.active;
        if (!a) return Promise.resolve({ ok: false as const, error: { error: { code: 'NO_ATTEMPT', message: 'No exercise is open.', retryable: false }, requestId: 'local' } });
        if (a.planPause?.exercise) {
          const ticket = session.ticket();
          const item = a.planPause.exercise;
          const level = await learnerLevel(item.concepts[0], eventContext(a)!.accountId);
          if (!session.isCurrent(ticket)) return { ok: false as const, error: { error: { code: 'STALE_ATTEMPT', message: 'Exercise closed.', retryable: false }, requestId: 'local' } };
          const reply = await sendPlanRequest({ type: 'hintV2', exerciseId: item.id, revision: item.revision,
            code: input.code, hintLevel: input.level, learnerLevel: level }, HintResponseSchema, sendV2);
          if (reply.ok && session.isCurrent(ticket) && input.level > 0) {
            eventContext(a)!.hintsUsed++; practiceEvent('hint_used', a, { hintLevel: input.level });
          }
          return reply;
        }
        return sendRequest({ type: 'hint', exerciseId: a.breakpoint.exercise.id, revision: a.revision, ...input } as WorkerMessage,
          HintResponseSchema, send);
      },
    };
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
    // YouTube is a single-page app: arriving from search results leaves that page's hidden, zero-width
    // #secondary earlier in the DOM. Take the first match that is actually laid out, not the first match,
    // otherwise the panel falls below the video until a hard reload.
    const visibleIn = (selector: string, minWidth: number) => [...document.querySelectorAll(selector)]
      .find(el => el.getBoundingClientRect().width >= minWidth) ?? null;
    const findAnchor = (): Element | null => {
      const theater = document.querySelector('ytd-watch-flexy[theater]:not([hidden])');
      const secondary = visibleIn('#secondary-inner, #secondary', 360);
      if (layout === 'side' && !theater && window.innerWidth >= 1100 && secondary) return secondary;
      const below = visibleIn('#below', 1);
      if (below) return below;
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
      // The initial discovery deadline is not a permanent failure. A bound
      // YouTube player can finish buffering after it expires; recover only
      // for this route's ready, connected player and a usable panel anchor.
      if (bindExpired && playerReady && player === currentPlayer() && player && player.readyState >= 2 && mountable()) {
        bindExpired = false;
      }
      void renderTimeline();
      if (!ui?.mounted || !isCurrent() || uiFailed) return;
      const active = session.active;
      if (active) eventContext(active);
      const breakpoints = session.data?.breakpoints ?? [];
      const state = bindExpired || session.route === 'unavailable' ? 'unavailable'
        : session.route === 'loading' || (prepared === false && plan?.status === 'planning' && breakpoints.length === 0) ? 'loading' : 'ready';
      const remaining = breakpoints.filter(b => session.available(b));
      const solved = breakpoints.filter(b => session.solvedIds.has(b.exercise.id)).length;
      let panel: RenderedPanel | null = null;
      if (active && session.videoId) {
        const ticket = session.ticket();
        const plannedItem = active.planPause?.exercise ?? active.planPause?.question;
        panel = {
          videoId: session.videoId, revision: active.revision, breakpoint: active.breakpoint,
          language: active.breakpoint.exercise.language,
          attempt: active.state, result: active.result, error: active.error, canResume: active.canResume,
          ...(plannedItem ? {
            manualResume: true, accountId: eventContext(active)!.accountId,
            conceptLevels: plannedItem.concepts.map(concept => ({
              concept, level: plannedItem.level,
            })),
            feedback: feedbackState && session.isCurrent(feedbackState.ticket)
              ? { result: feedbackState.feedback, submittedCode: feedbackState.code } : null,
            progress: progressState && session.isCurrent(progressState.ticket) ? progressState.award : null,
          } : {}),
          aiGenerated: active.generated, ownsPause: active.ownsPause,
          ...(active.generated ? {} : {
            index: Math.max(0, breakpoints.findIndex(b => b.id === active.breakpoint.id)), total: breakpoints.length,
          }),
          holdMs: SOLVED_HOLD_MS,
          // Cached Test me sets may reuse the same exercise ID. Only the exact
          // submission ticket may supply feedback to this panel instance.
          analysis: analysisState && session.isCurrent(analysisState.ticket) ? analysisState.state : null,
          onRun: code => void grade('run', code), onSubmit: code => void grade('submit', code),
          onSkip: skip, onClose: skip, onResume: () => resumeNow(ticket),
        };
        clearTimeout(leavingTimer); leavingPanel = null;
      } else if (shownPanel) {
        // Keep the finished panel mounted, inert, for its exit animation.
        leavingPanel = { ...shownPanel, leaving: true, onRun: noop, onSubmit: noop, onSkip: noop, onResume: noop, onClose: noop };
        clearTimeout(leavingTimer);
        leavingTimer = setTimeout(() => { leavingPanel = null; render(); }, 220);
      }
      shownPanel = active?.planPause?.question ? null : panel;
      const visiblePanel = panel ?? leavingPanel;
      const request = session.testMe;
      const testMe = testMeEnabled ? {
        canStart: !active && !request && document.visibilityState === 'visible' && !!testMePlayer(),
        request: request ? (request.error ? { status: 'error' as const, error: request.error } : { status: 'loading' as const }) : null,
        aiGenerated: !!visiblePanel?.aiGenerated,
        onStart: startTestMe, onRetry: retryTestMe, onClose: closeTestMe,
      } : null;
      try {
        flushSync(() => ui!.mounted!.render(<HintsContext.Provider value={hints}><TestMeContext.Provider value={testMe}><div className="breakpoint-shell" data-theme={theme()}
          data-placement={anchor?.id === 'secondary-inner' || anchor?.id === 'secondary' ? 'side' : 'below'}>
          <WorkspaceContext.Provider value={{ layout, effectiveLayout: anchor?.id === 'secondary-inner' || anchor?.id === 'secondary' ? 'side' : 'below', saving: layoutSaving, onChange: changeLayout, onPauseVideo: session.videoId && !settings.disabledVideos.includes(session.videoId) ? () => {
            const videoId = session.videoId!;
            void saveLearnerSettings({ ...settings, disabledVideos: [...settings.disabledVideos, videoId] }).catch(() => { layoutError = 'Could not save this preference. Please try again.'; render(); });
          } : undefined }}>
          {prepared === false && plan && ['not_coding', 'no_captions'].includes(plan.status) && !dismissedUnavailable
            ? <TopicNotAvailable reason={plan.verdict.reason} onDismiss={() => { dismissedUnavailable = true; render(); }} />
            : session.route !== 'unsupported' && <div data-breakpoint-badge hidden={!!visiblePanel}>
            <Badge state={state} total={breakpoints.length} remaining={remaining.length} solved={solved}
              active={!!active && !active.generated} nextAtS={remaining[0]?.pauseAtS ?? null} onOpen={openFromBadge} />
          </div>}
          <TestMeControls />
          {refresher && !active && !request && accountReady && playerReady &&
            <RefresherPrompt due={[{ concept: refresher.concept, reason: refresher.reason }]}
              onStart={startRefresher} onDismiss={() => { refresher = null; render(); }} />}
          {layoutError && <p className="bp-layout-error" role="alert">{layoutError}</p>}
          {visiblePanel && <div data-breakpoint-panel data-ai-generated={visiblePanel.aiGenerated || undefined} tabIndex={-1} style={{ width: '100%' }}>
            {active?.planPause?.question
              ? <ConceptQuestionPanel key={`${session.generation}/${active.planPause.question.id}`}
                  question={active.planPause.question} checking={active.state === 'checking'}
                  {...{ error: active.error, canResume: active.canResume }}
                  feedback={feedbackState && session.isCurrent(feedbackState.ticket) ? feedbackState.feedback : null}
                  progress={progressState && session.isCurrent(progressState.ticket) ? progressState.award : null}
                  onAnswer={answer => void answerQuestion(answer)} onSkip={skip} onClose={skip} onResume={visiblePanel.onResume} />
              : <PracticePanel key={`${session.generation}/${visiblePanel.breakpoint.exercise.id}`} {...visiblePanel} />}
          </div>}
        </WorkspaceContext.Provider></div></TestMeContext.Provider></HintsContext.Provider>));
      } catch { failMount(); }
    }

    async function changeLayout(next: PracticeLayout) {
      if (layoutSaving || next === layout) return;
      layoutSaving = true; layoutError = null; render();
      try {
        await savePracticeLayout(next);
        layout = next;
        await ensureUi();
      } catch { layoutError = 'Could not save this layout. Please try again.'; }
      finally { layoutSaving = false; render(); }
    }

    function cancelTimelineSelection() {
      timelineSelection?.abort(); timelineSelection = undefined;
    }

    async function selectTimeline(id: string) {
      const video = testMePlayer();
      const marker = video && session.timelineMarkers(video.duration).find(m => m.id === id);
      if (!video || !marker || session.active || session.testMe || !accountReady) return;
      cancelTimelineSelection();
      const controller = new AbortController(); timelineSelection = controller;
      const generation = session.generation, account = accountId, source = video.currentSrc;
      const ownsPause = !video.paused;
      watch.reset(); session.reset();
      const sought = await seekForPractice(video, marker.timeS, controller.signal);
      if (timelineSelection !== controller) return;
      timelineSelection = undefined;
      const current = session.timelineMarkers(video.duration).find(m => m.id === id);
      // Re-read every identity after the asynchronous seek. Polling may change
      // readiness/timing, and navigation, account changes or native play must
      // never reopen a stale challenge or credit the skipped watch interval.
      if (!sought || !isCurrent() || generation !== session.generation || account !== accountId ||
          source !== video.currentSrc || video !== currentPlayer() || !current || current.timeS !== marker.timeS ||
          video.seeking || !video.paused || isAd() || isFullscreen() || !mountable() ||
          document.visibilityState !== 'visible') return;
      if (session.openFromTimeline(id, video.currentTime, ownsPause)) {
        feedbackState = null; analysisState = null; progressState = null;
        render(); focusPanel(); releaseEmptyPanel(video);
      }
    }

    async function renderTimeline() {
      if (!isCurrent()) return;
      const video = player;
      const movie = document.querySelector<HTMLElement>('#movie_player');
      const bar = movie?.querySelector<HTMLElement>('.ytp-progress-bar');
      const markers = video && playerReady && accountReady ? session.timelineMarkers(video.duration) : [];
      if (!movie || !bar || !markers.length || isAd() || isFullscreen() || !mountable() || session.active || session.testMe) {
        if (timelineUi) timelineUi.shadowHost.style.display = 'none';
        return;
      }
      if (!timelineUi && !timelineMounting) {
        const generation = session.generation;
        timelineMounting = true;
        try {
          const created = await createShadowRootUi(ctx, {
            name: 'breakpoint-timeline', position: 'inline', anchor: movie, append: 'last', isolateEvents: true,
            // WXT's default all:initial !important also resets our dynamic host
            // position/display. Use the normal-priority reset in timeline.css
            // so measured placement and active-attempt hiding can take effect.
            inheritStyles: true,
            css: `${themeCss}\n${timelineCss}`,
            onMount: container => createRoot(container), onRemove: root => root?.unmount(),
          });
          if (generation !== session.generation || !isCurrent()) { created.remove(); return; }
          timelineUi = created; timelineUi.mount(); timelineSignature = '';
        } catch { return; }
        finally { if (generation === session.generation) timelineMounting = false; }
      }
      if (!timelineUi?.mounted) return;
      if (timelineUi.shadowHost.parentElement !== movie) movie.append(timelineUi.shadowHost);
      const rect = bar.getBoundingClientRect(), parent = movie.getBoundingClientRect();
      // B2 insets each icon 16px inside its track. Extend our rail by that
      // amount on each side so the icon centers match actual seekbar times.
      // The complete 40px control sits above the native bar, never over it.
      Object.assign(timelineUi.shadowHost.style, {
        position: 'absolute', left: `${rect.left - parent.left - 16}px`, top: `${rect.top - parent.top - 44}px`,
        width: `${rect.width + 32}px`, height: '40px', zIndex: '60', pointerEvents: 'none',
        display: rect.width > 0 && rect.height > 0 ? 'block' : 'none',
      });
      const signature = JSON.stringify([session.generation, accountId, markers, theme()]);
      if (signature !== timelineSignature) {
        timelineSignature = signature;
        timelineUi.mounted.render(<div className="breakpoint-shell breakpoint-timeline" data-theme={theme()}>
          <TimelineMarkers markers={markers} onSelect={id => void selectTimeline(id)} />
        </div>);
      }
    }

    function applyPlan() {
      // Prepared lessons keep their existing v1 grading and revision flow.
      // A racing plan response is held until the v1 lookup decides ownership.
      if (plan && prepared === false) {
        session.acceptPlan(session.generation, plan, settings);
        for (const id of planSolvedIds) session.solvedIds.add(id);
      }
      session.autoPause = settings.autoPause && !settings.disabledVideos.includes(session.videoId ?? '');
      render();
    }

    async function restorePlanProgress(incoming: ExercisePlan, generation: number, account: string) {
      const solved = await Promise.all(incoming.pauses.map(async p => {
        const item = p.exercise ?? p.question;
        return item && await planSolved(account, incoming.videoId, item.id, item.revision).catch(() => false) ? item.id : null;
      }));
      if (generation !== session.generation || plan !== incoming || account !== accountId || !isCurrent()) return;
      planSolvedIds = new Set(solved.filter((id): id is string => id !== null));
      applyPlan();
    }

    async function loadRoute(generation: number, videoId: string) {
      try {
        const stored = await browser.storage.local.get([SETTINGS_KEY, ACCOUNT_KEY, PRACTICE_LAYOUT_KEY]);
        layout = readPracticeLayout(stored[PRACTICE_LAYOUT_KEY]);
        void ensureUi();
        if (generation !== session.generation || !isCurrent()) return;
        settings = readSettings(stored[SETTINGS_KEY]); accountId = readAccount(stored[ACCOUNT_KEY]);
        accountReady = true;
      } catch { settings = readSettings({}); }
      if (generation !== session.generation || !isCurrent()) return;
      session.autoPause = settings.autoPause && !settings.disabledVideos.includes(videoId);
      void lookup();
      void loadPlan(generation, videoId, accountId);
      void loadRefresher(generation, accountId);
    }

    async function loadRefresher(generation: number, account: string) {
      const sequence = ++refresherSequence;
      refresher = null;
      if (!accountReady) return;
      const reply = await sendPlanRequest({ type: 'refresherV2', accountId: account }, RefresherSchema, sendV2);
      // Neither a response from a previous watch page nor a previous learner
      // may offer their question in the current tab. Failures leave playback alone.
      if (sequence !== refresherSequence || generation !== session.generation || account !== accountId || !isCurrent()) return;
      refresher = reply.ok ? reply.data : null;
      render();
    }

    function startRefresher(concept: string) {
      const offer = refresher, video = player;
      if (!offer || offer.concept !== concept || offer.accountId !== accountId || !video || !accountReady ||
          !playerReady || !isCurrent() || video !== currentPlayer() || video.seeking || isAd() || isFullscreen() ||
          document.visibilityState !== 'visible' || !mountable()) return;
      const ticket = session.startRefresher(offer.question, video.currentTime, !video.paused);
      if (!ticket) return;
      refresher = null; feedbackState = null; progressState = null;
      eventContext(); // Capture the learner before any async answer work starts.
      video.pause(); render(); focusPanel(); releaseEmptyPanel(video);
    }

    async function loadPlan(generation: number, videoId: string, account: string) {
      const sequence = ++planLoadSequence;
      planLoader?.stop();
      const levels = await sendPlanRequest({ type: 'levelsV2', accountId: account }, LevelsResultSchema, sendV2);
      if (sequence !== planLoadSequence || generation !== session.generation || account !== accountId || !isCurrent()) return;
      // A1 confirms POST is an idempotent cached read after job creation. Reuse
      // this exact body when polling so two accounts cannot exchange plans via
      // the legacy GET endpoint's "latest POST" level-map selector.
      const request = { type: 'plan' as const, videoId, learnerLevel: 'beginner-1', learnerLevels: levels.ok ? levels.data.levels : {} };
      planLoader = new PlanLoader(() => sendPlanRequest(request, ExercisePlanSchema, sendV2), incoming => {
        if (sequence !== planLoadSequence || generation !== session.generation || account !== accountId || !isCurrent()) return;
        plan = incoming;
        void restorePlanProgress(incoming, generation, accountId);
      });
      planLoader.start();
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
      if (!refresh) prepared = reply.ok && reply.data.status === 'ready';
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
      if (!refresh) applyPlan(); else render();
    }

    async function grade(mode: 'run' | 'submit', code: string) {
      const active = session.active;
      const videoId = session.videoId;
      if (!videoId || !active || active.error?.code === 'EXERCISE_NOT_FOUND' || active.error?.code === 'SET_EXPIRED') return;
      const ticket = session.beginGrade();
      if (!ticket) return;
      if (active.planPause?.exercise) {
        const item = active.planPause.exercise;
        const context = eventContext(active)!;
        feedbackState = null; progressState = null;
        if (mode === 'submit') context.attempts++;
        render();
        const concept = item.concepts[0];
        const level = await learnerLevel(concept, context.accountId);
        if (!isCurrent() || !session.isCurrent(ticket)) return;
        const reply = await sendPlanRequest({ type: 'submitV2', exerciseId: item.id, revision: item.revision,
          language: item.language, code, mode, learnerLevel: level }, SubmitResultSchema, sendV2);
        if (!isCurrent() || !session.isCurrent(ticket)) return;
        const action = session.finishGrade(ticket, mode, reply.ok ? { ok: true, data: reply.data.grade } : reply);
        if (action === 'ignored') return;
        if (reply.ok) {
          feedbackState = { ticket, feedback: reply.data.feedback, code };
          if (mode === 'submit') {
            const eventId = practiceEvent(reply.data.feedback.outcome, active, {
              ...(reply.data.feedback.diagnosis ? { misconception: reply.data.feedback.diagnosis.misconception.id } : {}),
            });
            if (action === 'passed') {
              void markPlanSolved(context.accountId, videoId, item.id, item.revision).catch(() => {});
              // XP gained, level and progress to the next level (replaces the racy rank-diff check).
              if (eventId) void showProgress(ticket, context.accountId, eventId);
            }
          }
        }
        // v2 feedback is instructional content. Keep it visible until the
        // learner explicitly resumes, including beginner explanations.
        render(); return;
      }
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
        // Persisting a prepared solve yields to storage. Navigation, Skip or a
        // new attempt during that wait must not start an obsolete review.
        if (!isCurrent() || !session.isCurrent(ticket)) return;
        if (action === 'passed') {
          clearTimeout(holdTimer);
          // Review every passing Submit, including learner-paused videos. An
          // inefficient pass stays visible until the learner leaves the panel.
          analysisState = { ticket, state: { status: 'loading' } };
          render();
          const review = await Promise.race([
            sendRequest({ type: 'analyze', exerciseId: active.breakpoint.exercise.id, revision: active.revision, code },
              AnalysisResponseSchema, send),
            new Promise<null>(done => setTimeout(() => done(null), 9000)),
          ]);
          if (!isCurrent() || !session.isCurrent(ticket)) return;
          const data = review && review.ok ? review.data : null;
          analysisState = { ticket, state: data ? { status: 'done', data } : { status: 'error' } };
          render();
          if (active.ownsPause && (!data || data.optimal)) {
            holdTimer = setTimeout(() => { holdTimer = undefined; void resume(ticket); }, SOLVED_HOLD_MS);
          }
        }
      }
    }

    async function answerQuestion(answer: string) {
      const active = session.active;
      const item = active?.planPause?.question;
      if (!active || !item || !answer.trim()) return;
      const ticket = session.beginGrade();
      if (!ticket) return;
      const context = eventContext(active)!;
      const concept = item.concepts[0];
      context.attempts++; feedbackState = null; progressState = null; render();
      const level = await learnerLevel(concept, context.accountId);
      if (!isCurrent() || !session.isCurrent(ticket)) return;
      const reply = await sendPlanRequest({ type: 'answerV2', questionId: item.id, revision: item.revision,
        answer, learnerLevel: level }, AnswerResultSchema, sendV2);
      if (!isCurrent() || !session.isCurrent(ticket)) return;
      if (!reply.ok) { active.state = 'failed'; active.error = reply.error.error; }
      else {
        active.state = reply.data.correct ? 'passed' : 'failed';
        if (reply.data.correct && !active.refresher) {
          session.solvedIds.add(item.id);
          void markPlanSolved(context.accountId, session.videoId!, item.id, item.revision).catch(() => {});
        }
        feedbackState = { ticket, feedback: reply.data.feedback, code: '' };
        let eventId: string | undefined;
        if (active.refresher && !active.refresherAnswered) {
          // B1 scores a refresher question once. Retrying a wrong answer may
          // teach the concept, but cannot stack ordinary pass or refresher XP.
          active.refresherAnswered = true;
          eventId = emitEvent({ type: 'refresher_answered', exerciseId: item.id, concepts: item.concepts,
            level, attempts: context.attempts, correct: reply.data.correct }, context.accountId);
        } else if (!active.refresher) {
          eventId = practiceEvent(reply.data.correct ? 'passed' : 'failed', active,
            reply.data.feedback.diagnosis ? { misconception: reply.data.feedback.diagnosis.misconception.id } : {});
        }
        // XP gained, level and progress after a correct answer (concept or refresher).
        if (reply.data.correct && eventId) void showProgress(ticket, context.accountId, eventId);
      }
      render();
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

    async function resume(ticket: Ticket, explicit = false) {
      const video = player;
      // Only the panel's explicit click may release a native pause. Automatic
      // solved/Skip paths retain the original ownership and frame checks.
      if (!video || !isCurrent() || video !== currentPlayer() || isAd() || isFullscreen() ||
          (explicit
            ? video.seeking || !session.canUserResume(ticket, video.currentTime, video.paused)
            : !session.canResume(ticket, video.currentTime, video.paused))) {
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

    function resumeNow(ticket: Ticket) {
      if (!session.isCurrent(ticket)) return;
      clearTimeout(holdTimer); holdTimer = undefined;
      void resume(ticket, true);
    }

    function skip() {
      clearTimeout(holdTimer); holdTimer = undefined;
      if (session.active?.state !== 'passed') practiceEvent('skipped');
      const ticket = session.skip();
      if (ticket) { render(); void resume(ticket); }
    }

    function openFromBadge() {
      if (session.route === 'loading') return;
      if (session.route === 'unavailable' || bindExpired || uiFailed) {
        bindExpired = false; uiFailed = false; observePlayer();
        if (prepared === false && session.videoId) {
          // Retrying v1 lookup alone would reapply the same terminal v2 error.
          // Discard it and let loadPlan cancel the old personalized poller.
          plan = null; session.route = 'loading'; session.reset(); render();
          void loadPlan(session.generation, session.videoId, accountId);
        } else void lookup();
        return;
      }
      const video = player;
      if (session.active || session.testMe || !video || !playerReady || !isCurrent() || video !== currentPlayer() || isAd() || isFullscreen() || !mountable()) return;
      const breakpoint = session.data?.breakpoints.find(b => session.available(b));
      if (!breakpoint) return;
      if (session.open(breakpoint, video.currentTime, !video.paused)) {
        video.pause(); render(); focusPanel();
        releaseEmptyPanel(video);
      }
    }

    function releaseEmptyPanel(video: HTMLVideoElement) {
      // B2's pre-wired views may still be stubs during lane integration. Never
      // hold the video behind an empty concept panel or a failed UI mount.
      if (session.active?.planPause && !ui?.shadow.querySelector('[data-breakpoint-panel]')?.childElementCount) {
        const ownsPause = session.canResume(session.ticket(), video.currentTime, video.paused);
        session.interrupt(); render();
        if (ownsPause) void video.play().catch(() => video.focus());
      }
    }

    function sample() {
      const video = player;
      if (!video || !isCurrent() || video !== currentPlayer()) { session.reset(); return; }
      const ad = isAd();
      watch.sample({ time: video.currentTime, wallMs: performance.now(), rate: video.playbackRate,
        playing: !video.paused && !video.ended, seeking: video.seeking, ad, ready: playerReady && accountReady });
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
      releaseEmptyPanel(video);
    }

    function bind(video: HTMLVideoElement) {
      cancelTimelineSelection();
      stopPlayer();
      watch.reset();
      session.interrupt(); player = video; session.reset();
      // YouTube can reuse the same element across routes. Wait for new media readiness in that case.
      playerReady = video.readyState >= 2 && (video !== oldPlayer || (!!video.currentSrc && video.currentSrc !== oldSource));
      lastAd = isAd();
      const controller = new AbortController();
      const on = (name: string, listener: EventListener) => video.addEventListener(name, listener, { signal: controller.signal });
      const interrupt = () => { session.interrupt(); render(); };
      on('loadedmetadata', () => { playerReady = video.readyState >= 1; session.reset(); render(); });
      on('durationchange', () => void renderTimeline());
      on('canplay', () => {
        // canplay without a metadata/source change may belong to the previous route.
        if (video !== oldPlayer || (!!video.currentSrc && video.currentSrc !== oldSource)) playerReady = true;
        session.reset(); render();
      });
      on('emptied', () => { playerReady = false; interrupt(); });
      on('seeking', () => { watch.reset(); interrupt(); });
      on('seeked', () => { session.reset(); if (testMeEnabled) render(); });
      if (testMeEnabled) on('ended', render);
      on('ratechange', () => { watch.reset(); session.reset(); });
      on('play', interrupt);
      on('pause', () => { watch.reset(); session.reset(); });
      on('waiting', () => watch.reset());
      on('ended', () => watch.reset());
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
      cancelTimelineSelection();
      timelineUi?.remove(); timelineUi = undefined; timelineMounting = false; timelineSignature = '';
      watch.reset(); planLoader?.stop(); planLoader = undefined;
      refresher = null; refresherSequence++;
      plan = null; planSolvedIds.clear(); prepared = null; dismissedUnavailable = false; feedbackState = null; progressState = null; accountReady = false;
      oldPlayer = player; oldSource = player?.currentSrc ?? '';
      stopPlayer(); observer?.disconnect(); observer = undefined;
      player = null; playerReady = false;
      ui?.remove(); ui = undefined; mounting = false; anchor = null; uiFailed = false; bindExpired = false;
      clearTimeout(holdTimer); holdTimer = undefined; analysisState = null;
      clearTimeout(leavingTimer); leavingPanel = null; shownPanel = null;
      session.navigate(id);
      if (!id) return;
      observePlayer(); void loadRoute(session.generation, id);
    }

    ctx.addEventListener(document, 'yt-navigate-finish', routeChanged);
    ctx.addEventListener(document, 'visibilitychange', () => { session.reset(); if (testMeEnabled) render(); });
    ctx.addEventListener(document, 'fullscreenchange', () => {
      session.reset();
      if (isFullscreen()) closeTestMe();
      if (testMeEnabled) render();
    });
    ctx.addEventListener(window, 'resize', () => { session.reset(); void ensureUi(); });
    const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      if (PRACTICE_LAYOUT_KEY in changes) {
        layout = readPracticeLayout(changes[PRACTICE_LAYOUT_KEY]?.newValue);
        void ensureUi(); render();
      }
      if (ACCOUNT_KEY in changes) {
        cancelTimelineSelection();
        watch.reset();
        // Switching learners invalidates in-flight grading and hides the old
        // learner's draft/feedback. Release only a pause this attempt owns.
        const video = player;
        const ownsPause = video && isCurrent() && video === currentPlayer() && !video.seeking && !isAd() && !isFullscreen() &&
          session.canResume(session.ticket(), video.currentTime, video.paused);
        session.interrupt(); feedbackState = null; progressState = null;
        accountId = readAccount(changes[ACCOUNT_KEY]?.newValue);
        void loadRefresher(session.generation, accountId);
        if (prepared === false) {
          session.solvedIds.clear(); session.consumed.clear();
          // An old learner's plan may contain a different difficulty. Stop
          // scheduling it immediately while the new account's plan is fetched.
          plan = null; planSolvedIds.clear(); session.data = null; session.route = 'loading'; session.reset();
        }
        if (session.videoId) void loadPlan(session.generation, session.videoId, accountId);
        render();
        if (ownsPause) void video.play().catch(() => video.focus());
      }
      if (SETTINGS_KEY in changes) {
        settings = readSettings(changes[SETTINGS_KEY]?.newValue); session.reset(); applyPlan();
      }
    };
    browser.storage.onChanged.addListener(onStorage);
    ctx.setInterval(() => { void browser.runtime.sendMessage({ type: 'flushEventsV2' }).catch(() => {}); }, 30000);
    ctx.setInterval(() => {
      if (lastHref !== location.href) routeChanged();
      if (!session.videoId || !isCurrent()) return;
      if (!bindExpired && currentPlayer() !== player && !observer) observePlayer();
      if (observer) findPlayer();
      const ad = isAd();
      if (ad !== lastAd) { watch.reset(); lastAd = ad; session.interrupt(); render(); }
      // Theater changes the anchor without necessarily resizing the window or
      // replacing the player, including after the initial observer expires.
      void ensureUi();
      void renderTimeline();
    }, 250);
    ctx.onInvalidated(() => { watch.reset(); planLoader?.stop(); browser.storage.onChanged.removeListener(onStorage);
      cancelTimelineSelection(); timelineUi?.remove();
      stopPlayer(); observer?.disconnect(); ui?.remove(); session.navigate(null); });
    routeChanged();
  },
});
