import type { ApiError, AttemptState, Breakpoint, PracticeResponse, SubmissionResponse, TestMeResponse, WorkerReply } from './contracts';
import type { ExercisePlan, PlanPause } from './v2/types';
import { pausesFor } from './plan';
import type { LearnerSettings } from './plan/settings';

export function watchVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get('v');
    return parsed.origin === 'https://www.youtube.com' && parsed.pathname === '/watch' && id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export type Sample = {
  time: number; wallMs: number; rate: number; playing: boolean; visible: boolean;
  ad: boolean; fullscreen: boolean; seeking: boolean; mountable: boolean; ready: boolean;
};
export type Ticket = { generation: number; attempt: number };
export type ActiveAttempt = {
  breakpoint: Breakpoint; revision: string; state: AttemptState; result: SubmissionResponse | null;
  error: ApiError['error'] | null; ownsPause: boolean; pausedAt: number; canResume: boolean; generated: boolean;
  planPause?: PlanPause;
  // A solved task may be reopened deliberately, but its review must not emit
  // another progress award. Capture this before grading changes solvedIds.
  reviewOnly?: boolean;
  wasConsumed?: boolean;
};
type TestMeAttempt = Pick<ActiveAttempt, 'ownsPause' | 'pausedAt' | 'error'>;

// DOM-free state and pause decisions. Every async continuation carries a generation/attempt ticket.
export class PlaybackSession {
  generation = 0;
  videoId: string | null = null;
  route: 'loading' | 'ready' | 'unsupported' | 'unavailable' = 'unsupported';
  data: PracticeResponse | null = null;
  active: ActiveAttempt | null = null;
  testMe: TestMeAttempt | null = null;
  readonly consumed = new Set<string>();
  readonly solvedIds = new Set<string>();
  private previous: Sample | null = null;
  private attempt = 0;
  private planPauses = new Map<string, PlanPause>();
  autoPause = true;

  navigate(videoId: string | null): number {
    this.generation++;
    this.videoId = videoId;
    this.data = null;
    this.route = videoId ? 'loading' : 'unsupported';
    this.active = null;
    this.testMe = null;
    this.planPauses.clear();
    this.attempt++;
    this.consumed.clear();
    this.solvedIds.clear();
    this.reset();
    return this.generation;
  }

  acceptLookup(generation: number, data: PracticeResponse, savedSolvedIds: ReadonlySet<string> = new Set()): boolean {
    if (generation !== this.generation || data.videoId !== this.videoId) return false;
    if (this.data?.revision !== data.revision) this.solvedIds.clear();
    for (const breakpoint of data.breakpoints) {
      const id = breakpoint.exercise.id;
      if (savedSolvedIds.has(id)) this.solvedIds.add(id);
    }
    this.data = data;
    this.route = data.status;
    // Late data must not turn an earlier time sample into an automatic pause.
    this.reset();
    return true;
  }

  reset(): void { this.previous = null; }

  acceptPlan(generation: number, plan: ExercisePlan, settings: LearnerSettings): boolean {
    if (generation !== this.generation || plan.videoId !== this.videoId) return false;
    const pauses = pausesFor(plan, settings.frequency);
    const previous = this.previous;
    const unchanged = plan.planId === this.data?.revision && pauses.length === this.planPauses.size && pauses.every(p => {
      const old = this.planPauses.get(p.id);
      return old && old.pauseAtS === p.pauseAtS && old.revealAtS === p.revealAtS && old.kind === p.kind &&
        (old.exercise ?? old.question)?.revision === (p.exercise ?? p.question)?.revision;
    });
    this.planPauses = new Map(pauses.map(p => [p.id, p]));
    const breakpoints: Breakpoint[] = pauses.map(p => ({
      id: p.id, pauseAtS: p.pauseAtS, revealAtS: p.revealAtS ?? Number.MAX_VALUE,
      exercise: p.exercise ?? {
        id: p.question!.id, title: p.question!.title, language: 'pseudocode',
        statement: p.question!.prompt, starterCode: '', examples: [],
      },
    }));
    this.autoPause = settings.autoPause && !settings.disabledVideos.includes(plan.videoId);
    // Do not interrupt an open attempt when a later polling result arrives.
    // Its captured revision and content remain authoritative until it closes.
    const accepted = this.acceptLookup(generation, ['ready', 'planning'].includes(plan.status)
      ? { schemaVersion: 1, videoId: plan.videoId, revision: plan.planId, status: 'ready', breakpoints }
      : { schemaVersion: 1, videoId: plan.videoId, revision: null, status: 'unsupported', breakpoints: [] });
    // A failed planner is retryable from the badge. Only a deliberate content
    // verdict (not coding / no captions) belongs to the unsupported route.
    if (accepted && plan.status === 'error') this.route = 'unavailable';
    // An unchanged poll must not erase a valid crossing for already-ready
    // content. Newly ready content still requires a fresh playback baseline.
    if (unchanged) this.previous = previous;
    return accepted;
  }

  available(breakpoint: Breakpoint): boolean {
    return !this.consumed.has(breakpoint.id) && !this.solvedIds.has(breakpoint.exercise.id);
  }

  sample(sample: Sample): Breakpoint | null {
    if (!this.autoPause || this.route !== 'ready' || !this.data || this.active || this.testMe || !sample.playing || !sample.visible ||
        sample.ad || sample.fullscreen || sample.seeking || !sample.mountable || !sample.ready ||
        !Number.isFinite(sample.time) || !Number.isFinite(sample.wallMs) || !Number.isFinite(sample.rate) || sample.rate <= 0) {
      this.reset(); return null;
    }
    const previous = this.previous;
    this.previous = sample;
    if (!previous) return null;
    const elapsed = (sample.wallMs - previous.wallMs) / 1000;
    const delta = sample.time - previous.time;
    // A stalled/background callback or an unannounced jump establishes a new baseline.
    if (elapsed < 0 || elapsed > 1.5 || delta < 0 || delta > elapsed * Math.max(sample.rate, previous.rate) + 0.5) return null;
    const breakpoint = this.data.breakpoints.find(b => this.available(b) &&
      previous.time < b.pauseAtS && b.pauseAtS <= sample.time && sample.time < b.revealAtS);
    return breakpoint && this.open(breakpoint, sample.time, true) ? breakpoint : null;
  }

  open(breakpoint: Breakpoint, time: number, ownsPause: boolean): Ticket | null {
    return this.openCurrent(breakpoint.id, time, ownsPause, false);
  }

  /** Explicit review can revisit consumed/skipped/solved pauses. Resolve the
   * current record by id so an obsolete marker cannot inject old plan content. */
  openFromTimeline(id: string, time: number, ownsPause: boolean): Ticket | null {
    return this.openCurrent(id, time, ownsPause, true);
  }

  private openCurrent(id: string, time: number, ownsPause: boolean, manual: boolean): Ticket | null {
    if (this.active || this.testMe || this.data?.status !== 'ready' || !Number.isFinite(time) || time < 0) return null;
    const breakpoint = this.data.breakpoints.find(b => b.id === id);
    if (!breakpoint || (!manual && !this.available(breakpoint))) return null;
    const wasConsumed = this.consumed.has(breakpoint.id);
    this.consumed.add(breakpoint.id);
    this.attempt++;
    this.active = { breakpoint, revision: this.data.revision, state: 'editing', result: null,
      error: null, ownsPause, pausedAt: time, canResume: false, generated: false,
      reviewOnly: manual && this.solvedIds.has(breakpoint.exercise.id), wasConsumed };
    const planned = this.planPauses.get(breakpoint.id);
    if (planned) {
      this.active.planPause = planned;
      this.active.revision = (planned.exercise ?? planned.question)!.revision;
    }
    this.reset();
    return this.ticket();
  }

  timelineMarkers(duration: number) {
    if (this.route !== 'ready' || this.data?.status !== 'ready' || !Number.isFinite(duration) || duration <= 0) return [];
    return this.data.breakpoints.filter(b => Number.isFinite(b.pauseAtS) && b.pauseAtS >= 0 && b.pauseAtS < duration).map(b => {
      const planned = this.planPauses.get(b.id);
      return {
        id: b.id, timeS: b.pauseAtS, position: Math.min(100, Math.max(0, b.pauseAtS / duration * 100)),
        title: b.exercise.title, kind: planned?.kind ?? 'coding' as const,
        concepts: [...((planned?.exercise ?? planned?.question)?.concepts ?? [])],
        status: this.solvedIds.has(b.exercise.id) ? 'passed' as const
          : this.consumed.has(b.id) ? 'attempted' as const : 'upcoming' as const,
      };
    }).sort((a, b) => a.timeS - b.timeS);
  }

  startTestMe(time: number, ownsPause: boolean): Ticket | null {
    if (!this.videoId || this.active || this.testMe || !Number.isFinite(time) || time < 0) return null;
    this.testMe = { pausedAt: time, ownsPause, error: null };
    this.attempt++;
    this.reset();
    return this.ticket();
  }

  retryTestMe(): Ticket | null {
    if (!this.testMe?.error?.retryable) return null;
    this.testMe.error = null;
    this.attempt++;
    return this.ticket();
  }

  finishTestMe(ticket: Ticket, reply: WorkerReply<TestMeResponse>): boolean {
    const request = this.testMe;
    if (!request || request.error || !this.isTestMeCurrent(ticket)) return false;
    if (!reply.ok) { request.error = reply.error.error; return true; }
    const { setId, exercise } = reply.data;
    // The shared panel displays the pause time. A manual exercise has no scheduled reveal.
    const breakpoint = { id: setId, pauseAtS: request.pausedAt, revealAtS: Number.MAX_VALUE, exercise };
    this.active = { breakpoint, revision: setId, state: 'editing', result: null,
      error: null, ownsPause: request.ownsPause, pausedAt: request.pausedAt, canResume: false, generated: true };
    this.testMe = null;
    return true;
  }

  ticket(): Ticket { return { generation: this.generation, attempt: this.attempt }; }
  private matches(ticket: Ticket): boolean {
    return ticket.generation === this.generation && ticket.attempt === this.attempt;
  }
  isCurrent(ticket: Ticket): boolean {
    return this.matches(ticket) && this.active !== null;
  }
  isTestMeCurrent(ticket: Ticket): boolean {
    return this.matches(ticket) && this.testMe !== null;
  }

  beginGrade(): Ticket | null {
    if (!this.active || this.active.state === 'checking' || this.active.state === 'passed' || this.active.canResume) return null;
    this.attempt++;
    this.active.state = 'checking';
    this.active.error = null;
    this.active.result = null;
    return this.ticket();
  }

  finishGrade(ticket: Ticket, mode: 'run' | 'submit', reply: WorkerReply<SubmissionResponse>): 'ignored' | 'stay' | 'passed' {
    if (!this.isCurrent(ticket) || this.active!.state !== 'checking') return 'ignored';
    const active = this.active!;
    if (!reply.ok) {
      active.state = 'failed'; active.error = reply.error.error;
      return 'stay';
    }
    active.result = reply.data;
    if (reply.data.outcome === 'passed' && mode === 'submit') {
      if (!active.generated) this.solvedIds.add(active.breakpoint.exercise.id);
      active.state = 'passed';
      // A passing Submit always unlocks the efficiency review. Pause ownership
      // controls playback separately: opening practice on an already-paused
      // video must not suppress feedback or grant permission to start it.
      return 'passed';
    }
    active.state = reply.data.outcome === 'passed' ? 'editing' : 'failed';
    return 'stay';
  }

  skip(): Ticket | null {
    if (!this.active) return null;
    this.attempt++; // A pending grade cannot act after Skip, including if play() rejects.
    this.active.state = 'idle';
    this.active.result = null;
    this.active.error = null;
    return this.ticket();
  }

  canResume(ticket: Ticket, time: number, paused: boolean): boolean {
    const practice = this.active ?? this.testMe;
    return this.matches(ticket) && practice?.ownsPause === true && paused && Math.abs(time - practice.pausedAt) < 0.25;
  }

  canUserResume(ticket: Ticket, time: number, paused: boolean): boolean {
    const active = this.active;
    // A deliberate Resume click may release a native pause, but never grants
    // ownership to a later automatic callback or an obsolete panel's button.
    return this.isCurrent(ticket) && active !== null && (active.state === 'passed' || active.canResume) &&
      paused && Math.abs(time - active.pausedAt) < 0.25;
  }

  resumeRejected(ticket: Ticket): void {
    // Explicit play can also be rejected for a learner-owned pause. Keep the
    // retry button reachable without changing who owns automatic playback.
    if (this.isCurrent(ticket)) this.active!.canResume = true;
  }

  releaseFailedMount(): void {
    if (this.active && !this.active.generated && !this.active.wasConsumed) this.consumed.delete(this.active.breakpoint.id);
    this.interrupt();
  }

  interrupt(): void {
    this.attempt++;
    this.active = null;
    this.testMe = null;
    this.reset();
  }
}
