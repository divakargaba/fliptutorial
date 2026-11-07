import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Code2, Play, Send, X } from 'lucide-react';
import type { Breakpoint, SubmissionResponse } from '../contracts';
import { flushDraft, loadDraft, saveDraft } from '../drafts';
import { PythonEditor } from './PythonEditor';

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
};

export function PracticePanel(props: PracticePanelProps) {
  const key = `${props.videoId}/${props.breakpoint.exercise.id}/${props.revision}`;
  return <Panel key={key} {...props} draftKey={key} />;
}

function Panel(props: PracticePanelProps & { draftKey: string }) {
  const { breakpoint: { exercise }, draftKey, attempt, result, error } = props;
  const [code, setCode] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const checking = attempt === 'checking';
  const invalidCode = code === null || !code.trim() || new TextEncoder().encode(code).length > 16384;

  useEffect(() => {
    let active = true;
    const root = heading.current?.getRootNode();
    const activeElement = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    const returnFocus = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement : root instanceof ShadowRoot ? root.querySelector<HTMLElement>('.bp-badge') : null;
    heading.current?.focus();
    void loadDraft(draftKey).then(draft => {
      if (active) setCode(draft ?? exercise.starterCode);
    }).catch(() => {
      if (active) { setCode(exercise.starterCode); setStorageError(true); }
    });
    return () => {
      active = false;
      void flushDraft(draftKey).catch(() => {});
      // The caller can focus its badge after unmount; preserve focus for manual opens.
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [draftKey, exercise.starterCode]);

  const changeCode = (next: string) => { setCode(next); saveDraft(draftKey, next); };
  const leave = (action: () => void) => {
    void flushDraft(draftKey).catch(() => {});
    action(); // Skip remains immediate even if storage or grading is unavailable.
  };
  const outcomeLabel = result?.outcome.replaceAll('_', ' ');
  return <section className="bp-panel flex flex-col" aria-labelledby="bp-heading">
    <header className="bp-header flex items-center gap-2">
      <Code2 size={16} aria-hidden="true" /><span className="bp-wordmark">BREAKPOINT</span>
      <span className="bp-language">Python</span>
      <button type="button" className="bp-icon-button" aria-label="Close practice" onClick={() => leave(props.onClose)}><X size={16} aria-hidden="true" /></button>
    </header>
    <div className="bp-body flex flex-col gap-4">
      <div><p className="bp-eyebrow">A MOMENT TO PRACTICE</p>
        <h2 id="bp-heading" ref={heading} tabIndex={-1}>{exercise.title}</h2>
        <p className="bp-statement">{exercise.statement}</p>
      </div>
      <details className="bp-examples"><summary>Examples <span>({exercise.examples.length})</span></summary>
        {exercise.examples.map((example, index) => <div className="bp-example" key={index}>
          <span className="bp-muted">Example {index + 1}</span>
          <code>Input: {JSON.stringify(example.args)}<br />Expected: {JSON.stringify(example.expected)}</code>
        </div>)}
      </details>
      <div><div className="bp-filebar"><label>main.py <span className="bp-muted">· Python</span></label></div>
        {code === null ? <p role="status">Restoring draft…</p> : <PythonEditor initialCode={code} onChange={changeCode} />}
        <p id="bp-editor-help" className="bp-help">Tab moves to the next control. Use spaces to indent.</p>
        {code !== null && new TextEncoder().encode(code).length > 16384 && <p className="bp-error">Code must be at most 16 KiB.</p>}
        {storageError && <p className="bp-muted">Draft recovery unavailable. Keep a copy before leaving.</p>}
      </div>
      <div className="bp-results" aria-live="polite" aria-atomic="true">
        {checking ? <p role="status">Checking your code… You can skip and continue watching.</p> : error ?
          <p className="bp-error"><CircleAlert size={16} aria-hidden="true" />{error.message} {error.retryable ? 'Try Run or Submit again, or skip.' : 'You can skip and continue watching.'}</p> : result ? <>
            <p className={result.outcome === 'passed' ? 'bp-success' : 'bp-error'}>
              {result.outcome === 'passed' ? <Check size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
              {attempt === 'passed' ? 'Exercise complete' : result.outcome === 'passed' ? 'Examples passed — Submit to finish' : outcomeLabel}
              {' · '}{result.passedCount}/{result.totalCount} passed
            </p>
            <ul>{result.results.map(row => <li key={`${row.kind}-${row.index}`}>
              <span>{row.kind === 'hidden' ? 'Hidden test' : 'Example'} {row.index + 1} · {row.passed ? 'Passed' : 'Failed'}</span>
              {row.kind === 'visible' && <code>Expected: {JSON.stringify(row.expected)} · Actual: {JSON.stringify(row.actual) ?? 'No output'}{row.diagnostic ? `\n${row.diagnostic}` : ''}</code>}
            </li>)}</ul>
          </> : <p className="bp-muted">Run checks the examples. Submit checks all tests.</p>}
      </div>
    </div>
    {props.canResume && <div className="bp-resume"><button type="button" className="bp-button bp-primary" onClick={props.onResume}><Play size={14} aria-hidden="true" />Resume video</button></div>}
    <footer className="bp-footer flex items-center gap-2">
      <button type="button" className="bp-skip" onClick={() => leave(props.onSkip)}>Skip and watch</button>
      <button type="button" className="bp-button" disabled={checking || invalidCode || attempt === 'passed'} onClick={() => props.onRun(code!)}><Play size={14} aria-hidden="true" />Run</button>
      <button type="button" className="bp-button bp-primary" disabled={checking || invalidCode || attempt === 'passed'} onClick={() => props.onSubmit(code!)}><Send size={14} aria-hidden="true" />Submit</button>
    </footer>
  </section>;
}
