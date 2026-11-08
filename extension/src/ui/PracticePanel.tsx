import { useContext, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, ExternalLink, Gauge, Lightbulb, LoaderCircle, Pause, Play, Send, Sparkles, X } from 'lucide-react';
import { LayoutSwitch, SuccessCelebration, WorkspaceContext } from './workspace';
import { PracticeMore } from './PracticeMore';
import { BrandMark } from './BrandMark';
import type { Breakpoint, HintResponse, LastResult, SubmissionResponse } from '../contracts';
import { HintsContext, type AnalysisState } from '../hints';
import { flushDraft, loadDraft, practiceDraftKey, saveDraft } from '../drafts';
import { PythonEditor } from './PythonEditor';
import { TestMeContext } from '../test-me';
import type { FeedbackResult, Language, LevelId } from '../v2/types';
import { FeedbackCard, LevelChip, LevelUp, ProgressCard, type Award } from './v2';
import { formatCall, formatTimestamp, formatValue, functionName, richText } from './format';

/** How long the solved moment stays on screen before the video resumes on its own. */
export const SOLVED_HOLD_MS = 1600;

export type PracticePanelProps = {
  videoId: string;
  revision: string;
  breakpoint: Breakpoint;
  attempt: 'idle' | 'editing' | 'checking' | 'failed' | 'passed';
  result: SubmissionResponse | null;
  error: { code: string; message: string; retryable: boolean } | null;
  canResume: boolean;
  ownsPause: boolean;
  onRun(code: string): void;
  onSubmit(code: string): void;
  onSkip(): void;
  onResume(): void;
  onClose(): void;
  /** 0-based position of this breakpoint and the video's breakpoint count, for "Challenge 2 of 3". */
  index?: number;
  total?: number;
  /** Rendered for its exit animation only; the attempt is already over. */
  leaving?: boolean;
  holdMs?: number;
  /** Efficiency review of the passing submission (content-script driven). */
  analysis?: AnalysisState | null;
  /** Optional v2 presentation; caller keeps feedback paired with its submitted code. */
  conceptLevels?: { concept: string; level: LevelId }[];
  levelUp?: { concept: string; level: LevelId } | null;
  /** What the pass earned (XP, level progress); shown under Solved. */
  progress?: Award | null;
  feedback?: { result: FeedbackResult; submittedCode: string } | null;
  /** v2 keeps success feedback visible until the learner explicitly resumes. */
  manualResume?: boolean;
  /** Local learner identity. Omit only for legacy v1 draft keys. */
  accountId?: string;
  /** Language of the exercise; Python remains the v1 default. */
  language?: Language;
};

export function PracticePanel(props: PracticePanelProps) {
  const key = practiceDraftKey(props.videoId, props.breakpoint.exercise.id, props.revision, props.accountId);
  return <Panel key={key} {...props} draftKey={key} />;
}

const VERDICT: Record<SubmissionResponse['outcome'], string> = {
  passed: 'Accepted', wrong_answer: 'Wrong answer', syntax_error: 'Syntax error',
  runtime_error: 'Runtime error', time_limit: 'Time limit exceeded', invalid_output: 'Invalid output',
};
const ERROR_TITLE: Record<string, string> = {
  GRADER_UNAVAILABLE: 'Grader unavailable', GRADER_TIMEOUT: 'Grading timed out', BUSY: 'Grader is busy',
  STALE_EXERCISE: 'Exercise updated', EXERCISE_NOT_FOUND: 'Exercise unavailable', INVALID_CODE: 'Check your code',
  NETWORK: 'Can’t reach Breakpoint', TIMEOUT: 'Request timed out',
  SET_EXPIRED: 'Practice expired',
};
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

function Panel(props: PracticePanelProps & { draftKey: string }) {
  const aiGenerated = useContext(TestMeContext)?.aiGenerated ?? false;
  const { breakpoint: { exercise }, draftKey, attempt, result, error, leaving = false } = props;
  const [code, setCode] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [lastMode, setLastMode] = useState<'run' | 'submit' | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const workspace = useContext(WorkspaceContext);
  const [hintOpen, setHintOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(workspace?.effectiveLayout !== 'side');
  const checking = attempt === 'checking';
  const solved = attempt === 'passed';
  const tooLarge = code !== null && new TextEncoder().encode(code).length > 16384;
  const invalidCode = code === null || !code.trim() || tooLarge;
  const blocked = leaving || checking || invalidCode || solved || error?.code === 'SET_EXPIRED';
  const fn = functionName(exercise.starterCode);
  const language = props.language ?? 'python';
  const stdio = ['typescript', 'c', 'csharp', 'go', 'rust'].includes(language);
  const filename = { python: 'main.py', javascript: 'main.js', typescript: 'main.ts', java: 'Main.java', cpp: 'main.cpp', c: 'main.c', csharp: 'Main.cs', go: 'main.go', rust: 'main.rs', sql: 'query.sql', pseudocode: 'pseudocode.txt', unknown: 'code.txt' }[language];
  const value = (item: unknown) => language === 'python' ? formatValue(item) : JSON.stringify(item) ?? 'no output';
  const coach = useHints(props, code);
  useEffect(() => { if (coach.hints.length) setHintOpen(true); }, [coach.hints.length]);
  useEffect(() => { setInstructionsOpen(workspace?.effectiveLayout !== 'side'); }, [workspace?.effectiveLayout]);
  const backToCode = () => {
    setHintOpen(false);
    panelRef.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus({ preventScroll: true });
  };

  useEffect(() => {
    let active = true;
    const root = heading.current?.getRootNode();
    const activeElement = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    const returnFocus = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement : root instanceof ShadowRoot ? root.querySelector<HTMLElement>('.bp-badge') : null;
    heading.current?.focus({ preventScroll: true });
    void loadDraft(draftKey).then(draft => {
      if (active) setCode(draft ?? exercise.starterCode);
    }).catch(() => {
      if (active) { setCode(exercise.starterCode); setStorageError(true); }
    });
    return () => {
      active = false;
      void flushDraft(draftKey).catch(() => {});
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      else (root instanceof ShadowRoot ? root : document).querySelector<HTMLElement>('.bp-badge')?.focus({ preventScroll: true });
    };
  }, [draftKey, exercise.starterCode]);

  // Move screen-reader focus to the solved heading when the moment appears.
  useEffect(() => { if (solved) heading.current?.focus({ preventScroll: true }); }, [solved]);

  const changeCode = (next: string) => { setHintOpen(false); setCode(next); saveDraft(draftKey, next); };
  const leave = (action: () => void) => {
    void flushDraft(draftKey).catch(() => {});
    action(); // Skip stays immediate even if storage or grading is unavailable.
  };
  const run = () => { if (!blocked) { setLastMode('run'); props.onRun(code!); } };
  const submit = () => { if (!blocked) { setLastMode('submit'); props.onSubmit(code!); } };
  const total = props.total ?? 1;

  return <section ref={panelRef} className={`bp-panel bp-workbench${leaving ? ' bp-leaving' : ''}`} data-attempt={attempt}
    aria-labelledby="bp-heading" inert={leaving || undefined}>
    <header className="bp-header">
      <span className="bp-workspace-brand"><BrandMark size={18} /><span>Breakpoint</span></span>
      <span className="bp-paused"><Pause size={12} aria-hidden="true" />Paused at {formatTimestamp(props.breakpoint.pauseAtS)}</span>
      {total > 1 && <span className="bp-step">{(props.index ?? 0) + 1} of {total}</span>}
      <LayoutSwitch />
      <button type="button" className="bp-icon-button" aria-label="Close practice" onClick={() => leave(props.onClose)}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>

    {props.levelUp && !props.progress && <LevelUp {...props.levelUp} />}
    {solved ? <><Solved heading={heading} result={result} canResume={props.canResume} ownsPause={props.ownsPause} manualResume={props.manualResume ?? false} analysis={props.analysis ?? null}
      resumeAtS={props.breakpoint.pauseAtS} holdMs={props.holdMs ?? SOLVED_HOLD_MS} onResume={props.onResume} />
      {props.progress && <div className="bp-v2-panel-levels"><ProgressCard award={props.progress} /></div>}</> : <>
      <div className="bp-body bp-workbench-body">
        <aside className="bp-task">
        <div className="bp-intro">
          <h2 id="bp-heading" ref={heading} tabIndex={-1}>{exercise.title}</h2>
        </div>
        <div className="bp-task-meta">
          {!!props.conceptLevels?.length && props.conceptLevels.map(item => <LevelChip key={item.concept} {...item} />)}
          {aiGenerated && <small>AI-generated practice</small>}
        </div>
        <details className="bp-instructions" open={instructionsOpen} onToggle={event => setInstructionsOpen(event.currentTarget.open)}>
          <summary>Instructions &amp; examples<ChevronDown size={14} aria-hidden="true" /></summary>
          <p className="bp-statement">{richText(exercise.statement)}</p>

        <div className="bp-examples bp-stagger" role="group" aria-label="Examples">
          {exercise.examples.slice(0, 3).map((example, i) => stdio ? <div className="bp-example bp-example-stdio" key={i}>
            <div><span className="bp-stdio-label">Input</span><pre>{example.args[0] as string}</pre></div>
            <div><span className="bp-stdio-label">Output</span><pre>{example.expected as string}</pre></div>
          </div> : <div className="bp-example" key={i}>
            <code className="bp-call">{language === 'python' ? formatCall(fn, example.args) : `Input: ${example.args.map(value).join(', ')}`}</code>
            <span className="bp-arrow" aria-label="returns">→</span>
            <code className="bp-expected">{value(example.expected)}</code>
          </div>)}
        </div>

        </details>
        </aside>
        <div className="bp-code-column">
        <div className="bp-editor-card">
          <div className="bp-editor-tab">
            <span className="bp-file"><span className="bp-file-dot" aria-hidden="true" />{filename}</span>
            <span id="bp-editor-help" className="bp-hint">
              <kbd>{MOD}</kbd><kbd>↵</kbd> run <span aria-hidden="true">·</span> Tab to leave editor
            </span>
          </div>
          {code === null
            ? <div className="bp-editor-loading" role="status">Restoring your draft…</div>
            : <PythonEditor key={language} language={language} initialCode={code} onChange={changeCode} onRun={run} onSubmit={submit} describedBy="bp-editor-help" />}
        </div>
        {tooLarge && <p className="bp-inline-error">Code must be at most 16 KiB.</p>}
        {storageError && <p className="bp-note">Draft saving is unavailable here — copy your code before leaving.</p>}

        <Results attempt={attempt} lastMode={lastMode} result={result} error={error} coach={coach} value={value} />
        {props.feedback && <div className="bp-workbench-feedback"><FeedbackCard feedback={props.feedback.result} code={props.feedback.submittedCode} /></div>}
        </div>
      </div>

      {props.canResume && <div className="bp-resume-bar">
        <span>The browser didn’t resume playback.</span>
        <button type="button" className="bp-button bp-primary" onClick={props.onResume}><Play size={14} aria-hidden="true" />Resume video</button>
      </div>}

      <footer className="bp-footer">
        <HintsSection coach={coach} disabled={leaving || checking} open={hintOpen} onOpen={setHintOpen} onBack={backToCode} />
        <PracticeMore onLater={() => leave(props.onSkip)} />
        <button type="button" className="bp-button bp-secondary" disabled={blocked} aria-busy={checking && lastMode === 'run'}
          onClick={run} title={`Run examples (${MOD}+Enter)`}>
          {checking && lastMode === 'run' ? <LoaderCircle size={14} className="bp-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}Run
        </button>
        <button type="button" className="bp-button bp-primary" disabled={blocked} aria-busy={checking && lastMode === 'submit'}
          onClick={submit} title={`Submit all tests (${MOD}+Shift+Enter)`}>
          {checking && lastMode === 'submit' ? <LoaderCircle size={14} className="bp-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}Submit
        </button>
      </footer>
    </>}
    {solved && props.feedback && <div className="bp-v2-panel-feedback"><FeedbackCard feedback={props.feedback.result} code={props.feedback.submittedCode} /></div>}
  </section>;
}

function Results({ attempt, lastMode, result, error, coach, value }: {
  attempt: PracticePanelProps['attempt']; lastMode: 'run' | 'submit' | null;
  result: SubmissionResponse | null; error: PracticePanelProps['error']; coach: Coach;
  value(item: unknown): string;
}) {
  const visible = result?.results.filter(row => row.kind === 'visible') ?? [];
  const hidden = result?.results.filter(row => row.kind === 'hidden') ?? [];
  const firstFailed = Math.max(0, visible.findIndex(row => !row.passed));
  const [selected, setSelected] = useState(firstFailed);
  useEffect(() => setSelected(firstFailed), [result, firstFailed]);
  const row = visible[selected];
  const examplesPassed = result?.outcome === 'passed';

  let body;
  if (attempt === 'checking') {
    body = <div className="bp-console-body" key="checking">
      <div className="bp-verdict"><LoaderCircle size={16} className="bp-spin" aria-hidden="true" />
        <span>{lastMode === 'submit' ? 'Running all tests…' : 'Running examples…'}</span></div>
      <div className="bp-skeleton" aria-hidden="true"><span /><span /><span /></div>
      <p className="bp-note">You can skip and keep watching while this finishes.</p>
    </div>;
  } else if (error) {
    body = <div className="bp-console-body bp-banner" key={`error-${error.code}`}>
      <CircleAlert size={16} aria-hidden="true" />
      <div><strong>{ERROR_TITLE[error.code] ?? 'Something went wrong'}</strong>
        <p>{error.message} {error.code === 'SET_EXPIRED'
          ? 'Your draft is kept. Close or skip, then use Test me to create a new exercise.'
          : error.retryable ? 'Try again, or skip and keep watching.' : 'Skip to keep watching.'}</p></div>
    </div>;
  } else if (result) {
    body = <div className="bp-console-body" key={JSON.stringify(result)}>
      <div className={`bp-verdict ${examplesPassed ? 'bp-pass' : 'bp-fail'}`}>
        {examplesPassed ? <Check size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
        <span>{examplesPassed ? 'Examples passed' : VERDICT[result.outcome]}</span>
        <span className="bp-count">{result.passedCount} / {result.totalCount} passed</span>
      </div>
      {examplesPassed && <p className="bp-note">Submit to run the hidden tests and finish.</p>}
      <div className="bp-cases">
        {visible.length > 0 && <div className="bp-case-tabs" role="tablist" aria-label="Test cases">
          {visible.map((r, i) => <button type="button" role="tab" key={r.index} aria-selected={i === selected}
            className={`bp-case ${r.passed ? 'is-pass' : 'is-fail'}`} onClick={() => setSelected(i)}>
            {r.passed ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}Case {r.index + 1}
          </button>)}
        </div>}
        {hidden.length > 0 && <div className="bp-hidden" aria-label={`${hidden.length} hidden tests, ${hidden.filter(r => r.passed).length} passed`}>
          <span className="bp-hidden-dots" aria-hidden="true">
            {hidden.map(r => <span key={r.index} className={r.passed ? 'is-pass' : 'is-fail'} />)}
          </span>{hidden.length} hidden
        </div>}
      </div>
      {row && <dl className="bp-case-detail" role="tabpanel">
        {row.args && <><dt>Input</dt><dd><code>{row.args.map(value).join(', ')}</code></dd></>}
        <dt>Expected</dt><dd><code>{value(row.expected)}</code></dd>
        <dt>Output</dt><dd><code className={row.passed ? 'bp-pass' : 'bp-fail'}>{value(row.actual)}</code></dd>
      </dl>}
      {row?.diagnostic && <pre className="bp-diagnostic">{row.diagnostic}</pre>}
      {!examplesPassed && <CoachFeedback coach={coach} />}
    </div>;
  } else {
    body = <p className="bp-console-idle" key="idle"><strong>Run</strong> checks the examples. <strong>Submit</strong> runs every test.</p>;
  }
  return <div className="bp-results" aria-live="polite" aria-atomic="true">{body}</div>;
}

function Solved({ heading, result, canResume, ownsPause, manualResume, resumeAtS, holdMs, onResume, analysis }: {
  heading: React.RefObject<HTMLHeadingElement | null>; result: SubmissionResponse | null; canResume: boolean;
  ownsPause: boolean;
  manualResume: boolean;
  resumeAtS: number; holdMs: number; onResume(): void; analysis: AnalysisState | null;
}) {
  const rows = result?.results ?? [];
  const review = analysis?.status === 'done' ? analysis.data : null;
  // Auto-resume only once the review is back and says the solution is already efficient.
  const counting = !analysis || analysis.status === 'error' || (review?.optimal ?? false);
  return <div className="bp-solved" role="status">
    <SuccessCelebration />
    <h2 id="bp-heading" ref={heading} tabIndex={-1}>Solved</h2>
    <p className="bp-solved-sub">{!result ? 'All tests passed' : result.totalCount === 1 ? '1 test passed' : `All ${result.totalCount} tests passed`}</p>
    {rows.length > 0 && <div className="bp-solved-dots" aria-hidden="true">
      {rows.map((r, i) => <span key={`${r.kind}-${r.index}`} style={{ animationDelay: `${420 + i * 45}ms` }} />)}
    </div>}
    {analysis?.status === 'loading' && <p className="bp-efficiency is-loading" role="status">
      <LoaderCircle size={14} className="bp-spin" aria-hidden="true" />Checking how efficient your solution is…</p>}
    {review?.optimal && <p className="bp-efficiency is-optimal">
      <Gauge size={14} aria-hidden="true" />Efficient · {review.learner.time} time · {review.learner.space} space</p>}
    {review && !review.optimal && <Efficiency review={review} />}
    {canResume ? <>
      <p className="bp-note">The browser didn’t resume playback.</p>
      <button type="button" className="bp-button bp-primary bp-wide" onClick={onResume}><Play size={14} aria-hidden="true" />Resume video</button>
    </> : manualResume && ownsPause ? <>
      <p className="bp-note">Review your feedback, then continue when you’re ready.</p>
      <button type="button" className="bp-button bp-primary bp-wide" onClick={onResume}><Play size={14} aria-hidden="true" />Resume video</button>
    </> : !ownsPause ? <>
      <p className="bp-note">Video stayed paused where you left it</p>
      <button type="button" className="bp-button bp-primary bp-wide" onClick={onResume}><Play size={14} aria-hidden="true" />Resume video</button>
    </> : counting && analysis?.status !== 'loading' ? <>
      <p className="bp-note">Now see how the instructor does it — back to {formatTimestamp(resumeAtS)}.</p>
      <div className="bp-countdown" aria-hidden="true"><span style={{ animationDuration: `${holdMs}ms` }} /></div>
      <button type="button" className="bp-button bp-secondary bp-wide" onClick={onResume}><Play size={14} aria-hidden="true" />Resume now</button>
    </> : <button type="button" className={`bp-button bp-wide ${review && !review.optimal ? 'bp-primary' : 'bp-secondary'}`} onClick={onResume}>
      <Play size={14} aria-hidden="true" />{review && !review.optimal ? 'Resume video' : 'Resume now'}</button>}
  </div>;
}

// ---------------------------------------------------------------------------
// Hints and coach feedback (H1)
// ---------------------------------------------------------------------------

type Coach = {
  hints: HintResponse[];
  loading: boolean;
  error: string | null;
  feedback: { text: string | null; loading: boolean; sources: HintResponse['sources'] } | null;
  available: boolean;
  next(): void;
};

function lastResultOf(result: SubmissionResponse | null): LastResult | undefined {
  if (!result || result.outcome === 'passed') return undefined;
  const row = result.results.find(r => !r.passed && r.kind === 'visible');
  if (row && row.kind === 'visible') {
    return { outcome: result.outcome, args: row.args, expected: row.expected, actual: row.actual,
      diagnostic: row.diagnostic ? row.diagnostic.slice(0, 4000) : null };
  }
  return { outcome: result.outcome };
}

function useHints(props: PracticePanelProps, code: string | null): Coach {
  const ctx = useContext(HintsContext);
  const [hints, setHints] = useState<HintResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Coach['feedback']>(null);
  const codeRef = useRef(code);
  codeRef.current = code;
  const failing = props.attempt !== 'checking' ? lastResultOf(props.result) : undefined;
  const failingKey = failing ? JSON.stringify(props.result) : null;

  // Feedback on every wrong attempt: explain the failing case, never the fix.
  useEffect(() => {
    if (!ctx || !failing || codeRef.current === null) { setFeedback(null); return; }
    let live = true;
    setFeedback({ text: null, loading: true, sources: [] });
    void ctx.requestHint({ code: codeRef.current, level: 0, lastResult: failing }).then(reply => {
      if (!live) return;
      setFeedback(reply.ok ? { text: reply.data.feedback, loading: false, sources: reply.data.sources } : null);
    });
    return () => { live = false; };
  }, [failingKey, ctx, code === null]);

  const next = () => {
    if (!ctx || loading || codeRef.current === null || hints.length >= 3) return;
    setLoading(true); setError(null);
    void ctx.requestHint({ code: codeRef.current, level: hints.length + 1, lastResult: lastResultOf(props.result),
      previousHints: hints.map(h => h.hint ?? '').filter(Boolean) }).then(reply => {
      setLoading(false);
      if (reply.ok && reply.data.hint) setHints(h => [...h, reply.data]);
      else setError(reply.ok ? 'No hint available right now.' : reply.error.error.message);
    });
  };
  return { hints, loading, error, feedback, available: !!ctx, next };
}

function CoachFeedback({ coach }: { coach: Coach }) {
  if (!coach.feedback || (!coach.feedback.loading && !coach.feedback.text)) return null;
  return <div className="bp-coach">
    <Sparkles size={14} aria-hidden="true" />
    {coach.feedback.loading
      ? <span className="bp-coach-loading">Looking at what went wrong…</span>
      : <div><strong>What went wrong</strong><p>{coach.feedback.text}</p></div>}
  </div>;
}

function HintsSection({ coach, disabled, open, onOpen, onBack }: {
  coach: Coach; disabled: boolean; open: boolean; onOpen(open: boolean): void; onBack(): void;
}) {
  const [selected, setSelected] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => setSelected(Math.max(0, coach.hints.length - 1)), [coach.hints.length]);
  if (!coach.available) return null;
  const used = coach.hints.length;
  const hint = coach.hints[selected];
  const request = () => { onOpen(true); coach.next(); };
  const close = () => { onOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <div className="bp-hints bp-help" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.stopPropagation(); close(); }
  }}>
    <button ref={trigger} type="button" className="bp-button bp-hint-button" aria-expanded={open} aria-controls="bp-hint-drawer"
      aria-label={used ? `Hints (${used} of 3)` : 'Stuck? Get a hint'} disabled={disabled || coach.loading}
      onClick={() => used ? onOpen(!open) : request()}>
      <span aria-hidden="true">💡</span>{coach.loading ? 'Finding a hint…' : used ? `Hints · ${used}` : 'Get a hint'}
    </button>
    {open && <section id="bp-hint-drawer" className="bp-help-popover" aria-label="Practice hints">
      <header><strong>{hint ? `Hint ${selected + 1} of 3` : 'A little guidance'}</strong>
        <button type="button" className="bp-icon-button" aria-label="Close hints" onClick={close}><X size={16} /></button></header>
      {used > 1 && <div className="bp-help-history" role="group" aria-label="Previous hints">
        {coach.hints.map((_, i) => <button key={i} type="button" aria-pressed={selected === i} onClick={() => setSelected(i)}>Hint {i + 1}</button>)}
      </div>}
      <div className="bp-help-content" aria-live="polite">
        {hint && <article className="bp-hint-card"><p className="bp-help-focus">{hint.focus}</p><p>{hint.hint}</p>
          {!!hint.sources.length && <div className="bp-hint-sources">{hint.sources.map(src => <a key={src.url} href={src.url} target="_blank" rel="noopener noreferrer">{src.title}<ExternalLink size={12} aria-hidden="true" /></a>)}</div>}
        </article>}
        {coach.loading && <p role="status">Finding a helpful nudge…</p>}
        {coach.error && <p className="bp-inline-error" role="alert">{coach.error}</p>}
      </div>
      <footer><button type="button" className="bp-text-button" onClick={onBack}>Back to code</button>
        {used < 3 ? <button type="button" className="bp-button bp-secondary" disabled={disabled || coach.loading} onClick={request}>
          {used ? `Next hint (${used + 1} of 3)` : 'Try again'}</button> : <span className="bp-note">All 3 hints saved</span>}
      </footer>
    </section>}
  </div>;
}

function Efficiency({ review }: { review: NonNullable<Extract<AnalysisState, { status: 'done' }>['data']> }) {
  const [open, setOpen] = useState(false);
  return <div className="bp-efficiency-card">
    <div className="bp-efficiency-head"><Gauge size={15} aria-hidden="true" />You passed, and it can be faster</div>
    <div className="bp-complexity">
      <span><em>Yours</em><strong className="bp-fail">{review.learner.time}</strong><small>{review.learner.space} space</small></span>
      <span className="bp-arrow" aria-hidden="true">→</span>
      <span><em>Possible</em><strong className="bp-pass">{review.best.time}</strong><small>{review.best.space} space</small></span>
    </div>
    <p>{review.summary}</p>
    {review.tip && <p className="bp-efficiency-tip"><Lightbulb size={13} aria-hidden="true" />{review.tip}</p>}
    {review.betterSolution && <>
      <button type="button" className="bp-disclosure" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <ChevronDown size={14} aria-hidden="true" />{open ? 'Hide' : 'Show'} a faster solution
      </button>
      {open && <pre className="bp-better-code"><code>{review.betterSolution}</code></pre>}
    </>}
  </div>;
}
