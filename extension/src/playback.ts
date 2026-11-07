import type { ApiError, AttemptState, Breakpoint, PracticeResponse, SubmissionResponse, WorkerReply } from './contracts';

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
  error: ApiError['error'] | null; ownsPause: boolean; pausedAt: number; canResume: boolean;
};

// DOM-free state and pause decisions. Every async continuation carries a generation/attempt ticket.
export class PlaybackSession {
  generation = 0;
  videoId: string | null = null;
  route: 'loading' | 'ready' | 'unsupported' | 'unavailable' = 'unsupported';
  data: PracticeResponse | null = null;
  active: ActiveAttempt | null = null;
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
    if (this.route !== 'ready' || !this.data || this.active || !sample.playing || !sample.visible ||
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
    if (this.active || this.data?.status !== 'ready' || !this.available(breakpoint) ||
        !this.data.breakpoints.some(b => b.id === breakpoint.id)) return null;
    this.consumed.add(breakpoint.id);
    this.attempt++;
    this.active = { breakpoint, revision: this.data.revision, state: 'editing', result: null,
      error: null, ownsPause, pausedAt: time, canResume: false };
    this.reset();
    return this.ticket();
  }

  ticket(): Ticket { return { generation: this.generation, attempt: this.attempt }; }
  isCurrent(ticket: Ticket): boolean {
    return ticket.generation === this.generation && ticket.attempt === this.attempt && this.active !== null;
  }

  beginGrade(): Ticket | null {
    if (!this.active || this.active.state === 'checking' || this.active.state === 'passed' || this.active.canResume) return null;
    this.attempt++;
    this.active.state = 'checking';
    this.active.error = null;
    this.active.result = null;
    return this.ticket();
  }

  finishGrade(ticket: Ticket, mode: 'run' | 'submit', reply: WorkerReply<SubmissionResponse>): 'ignored' | 'stay' | 'resume' {
    if (!this.isCurrent(ticket) || this.active!.state !== 'checking') return 'ignored';
    const active = this.active!;
    if (!reply.ok) {
      active.state = 'failed'; active.error = reply.error.error;
      return 'stay';
    }
    active.result = reply.data;
    if (reply.data.outcome === 'passed' && mode === 'submit') {
      this.solvedIds.add(active.breakpoint.exercise.id);
      active.state = 'passed';
      return active.ownsPause ? 'resume' : 'stay';
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
    return this.isCurrent(ticket) && this.active!.ownsPause && paused && Math.abs(time - this.active!.pausedAt) < 0.25;
  }

  resumeRejected(ticket: Ticket): void {
    if (this.isCurrent(ticket) && this.active!.ownsPause) this.active!.canResume = true;
  }

  releaseFailedMount(): void {
    if (this.active) this.consumed.delete(this.active.breakpoint.id);
    this.interrupt();
  }

  interrupt(): void {
    this.attempt++;
    this.active = null;
    this.reset();
  }
}
