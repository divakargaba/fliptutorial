import type { ApiError, AttemptState, Breakpoint, PracticeResponse, SubmissionResponse, TestMeResponse, WorkerReply } from './contracts';

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

  navigate(videoId: string | null): number {
    this.generation++;
    this.videoId = videoId;
    this.data = null;
    this.route = videoId ? 'loading' : 'unsupported';
    this.active = null;
    this.testMe = null;
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

  available(breakpoint: Breakpoint): boolean {
    return !this.consumed.has(breakpoint.id) && !this.solvedIds.has(breakpoint.exercise.id);
  }

  sample(sample: Sample): Breakpoint | null {
    if (this.route !== 'ready' || !this.data || this.active || this.testMe || !sample.playing || !sample.visible ||
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
    if (this.active || this.testMe || this.data?.status !== 'ready' || !this.available(breakpoint) ||
        !this.data.breakpoints.some(b => b.id === breakpoint.id)) return null;
    this.consumed.add(breakpoint.id);
    this.attempt++;
    this.active = { breakpoint, revision: this.data.revision, state: 'editing', result: null,
      error: null, ownsPause, pausedAt: time, canResume: false, generated: false };
    this.reset();
    return this.ticket();
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
    if (this.active && !this.active.generated) this.consumed.delete(this.active.breakpoint.id);
    this.interrupt();
  }

  interrupt(): void {
    this.attempt++;
    this.active = null;
    this.testMe = null;
    this.reset();
  }
}
