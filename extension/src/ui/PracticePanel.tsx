import { useContext, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, Pause, Play, Send, SkipForward, X } from 'lucide-react';
import type { Breakpoint, SubmissionResponse } from '../contracts';
import { flushDraft, loadDraft, saveDraft } from '../drafts';
import { PythonEditor } from './PythonEditor';
import { TestMeContext } from '../test-me';
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
};

export function PracticePanel(props: PracticePanelProps) {
  const key = `${props.videoId}/${props.breakpoint.exercise.id}/${props.revision}`;
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
  const checking = attempt === 'checking';
  const solved = attempt === 'passed';
  const tooLarge = code !== null && new TextEncoder().encode(code).length > 16384;
  const invalidCode = code === null || !code.trim() || tooLarge;
  const blocked = leaving || checking || invalidCode || solved || error?.code === 'SET_EXPIRED';
  const fn = functionName(exercise.starterCode);

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
    };
  }, [draftKey, exercise.starterCode]);

  // Move screen-reader focus to the solved heading when the moment appears.
  useEffect(() => { if (solved) heading.current?.focus({ preventScroll: true }); }, [solved]);

  const changeCode = (next: string) => { setCode(next); saveDraft(draftKey, next); };
  const leave = (action: () => void) => {
    void flushDraft(draftKey).catch(() => {});
    action(); // Skip stays immediate even if storage or grading is unavailable.
  };
  const run = () => { if (!blocked) { setLastMode('run'); props.onRun(code!); } };
  const submit = () => { if (!blocked) { setLastMode('submit'); props.onSubmit(code!); } };
  const total = props.total ?? 1;

  return <section className={`bp-panel${leaving ? ' bp-leaving' : ''}`} data-attempt={attempt}
    aria-labelledby="bp-heading" inert={leaving || undefined}>
    <header className="bp-header">
      <span className="bp-paused"><Pause size={12} aria-hidden="true" />Paused at {formatTimestamp(props.breakpoint.pauseAtS)}</span>
      {total > 1 && <span className="bp-step">Challenge {(props.index ?? 0) + 1} of {total}</span>}
      <button type="button" className="bp-icon-button" aria-label="Close practice" onClick={() => leave(props.onClose)}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>

    {aiGenerated && <p className="bp-generated-label bp-generated-panel">AI-generated practice</p>}

    {solved ? <Solved heading={heading} result={result} canResume={props.canResume}
      resumeAtS={props.breakpoint.pauseAtS} holdMs={props.holdMs ?? SOLVED_HOLD_MS} onResume={props.onResume} /> : <>
      <div className="bp-body">
        <div className="bp-intro bp-stagger">
          <h2 id="bp-heading" ref={heading} tabIndex={-1}>{exercise.title}</h2>
          <p className="bp-statement">{richText(exercise.statement)}</p>
        </div>

        <div className="bp-examples bp-stagger" role="group" aria-label="Examples">
          {exercise.examples.slice(0, 3).map((example, i) => <div className="bp-example" key={i}>
            <code className="bp-call">{formatCall(fn, example.args)}</code>
            <span className="bp-arrow" aria-label="returns">→</span>
            <code className="bp-expected">{formatValue(example.expected)}</code>
          </div>)}
        </div>

        <div className="bp-editor-card bp-stagger">
          <div className="bp-editor-tab">
            <span className="bp-file"><span className="bp-file-dot" aria-hidden="true" />main.py</span>
            <span id="bp-editor-help" className="bp-hint">
              <kbd>{MOD}</kbd><kbd>↵</kbd> run <span aria-hidden="true">·</span> Tab to leave editor
            </span>
          </div>
          {code === null
            ? <div className="bp-editor-loading" role="status">Restoring your draft…</div>
            : <PythonEditor initialCode={code} onChange={changeCode} onRun={run} onSubmit={submit} describedBy="bp-editor-help" />}
        </div>
        {tooLarge && <p className="bp-inline-error">Code must be at most 16 KiB.</p>}
        {storageError && <p className="bp-note">Draft saving is unavailable here — copy your code before leaving.</p>}

        <Results attempt={attempt} lastMode={lastMode} result={result} error={error} />
      </div>

      {props.canResume && <div className="bp-resume-bar">
        <span>The browser didn’t resume playback.</span>
        <button type="button" className="bp-button bp-primary" onClick={props.onResume}><Play size={14} aria-hidden="true" />Resume video</button>
      </div>}

      <footer className="bp-footer">
        <button type="button" className="bp-skip" onClick={() => leave(props.onSkip)}>
          <SkipForward size={14} aria-hidden="true" />Skip and watch
        </button>
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
  </section>;
}

function Results({ attempt, lastMode, result, error }: {
  attempt: PracticePanelProps['attempt']; lastMode: 'run' | 'submit' | null;
  result: SubmissionResponse | null; error: PracticePanelProps['error'];
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
        {row.args && <><dt>Input</dt><dd><code>{row.args.map(formatValue).join(', ')}</code></dd></>}
        <dt>Expected</dt><dd><code>{formatValue(row.expected)}</code></dd>
        <dt>Output</dt><dd><code className={row.passed ? 'bp-pass' : 'bp-fail'}>{formatValue(row.actual)}</code></dd>
      </dl>}
      {row?.diagnostic && <pre className="bp-diagnostic">{row.diagnostic}</pre>}
    </div>;
  } else {
    body = <p className="bp-console-idle" key="idle"><strong>Run</strong> checks the examples. <strong>Submit</strong> runs every test.</p>;
  }
  return <div className="bp-results" aria-live="polite" aria-atomic="true">{body}</div>;
}

function Solved({ heading, result, canResume, resumeAtS, holdMs, onResume }: {
  heading: React.RefObject<HTMLHeadingElement | null>; result: SubmissionResponse | null; canResume: boolean;
  resumeAtS: number; holdMs: number; onResume(): void;
}) {
  const rows = result?.results ?? [];
  return <div className="bp-solved" role="status">
    <svg className="bp-check" viewBox="0 0 52 52" aria-hidden="true">
      <circle className="bp-check-ring" cx="26" cy="26" r="24" />
      <path className="bp-check-tick" d="M15.5 27.5l7 7 14-15" />
    </svg>
    <h2 id="bp-heading" ref={heading} tabIndex={-1}>Solved</h2>
    <p className="bp-solved-sub">{!result ? 'All tests passed' : result.totalCount === 1 ? '1 test passed' : `All ${result.totalCount} tests passed`}</p>
    {rows.length > 0 && <div className="bp-solved-dots" aria-hidden="true">
      {rows.map((r, i) => <span key={`${r.kind}-${r.index}`} style={{ animationDelay: `${420 + i * 45}ms` }} />)}
    </div>}
    {canResume ? <>
      <p className="bp-note">The browser didn’t resume playback.</p>
      <button type="button" className="bp-button bp-primary bp-wide" onClick={onResume}><Play size={14} aria-hidden="true" />Resume video</button>
    </> : <>
      <p className="bp-note">Now see how the instructor does it — back to {formatTimestamp(resumeAtS)}.</p>
      <div className="bp-countdown" aria-hidden="true"><span style={{ animationDuration: `${holdMs}ms` }} /></div>
      <button type="button" className="bp-button bp-secondary bp-wide" onClick={onResume}><Play size={14} aria-hidden="true" />Resume now</button>
    </>}
  </div>;
}
