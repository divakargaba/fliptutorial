// Standalone UI acceptance fixture. It does not exercise the extension worker/playback.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import css from '../../src/ui/theme.css?inline';
import fixture from '../../../contracts/practice-response.fixture.json';
import failed from '../../../contracts/submission-response.fixture.json';
import { Badge } from '../../src/ui/Badge';
import { PracticePanel, type PracticePanelProps } from '../../src/ui/PracticePanel';

const local = {
  async get(key: string) { return { [key]: localStorage.getItem(key) ?? undefined }; },
  async set(values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  },
};
Object.assign(globalThis, { chrome: { storage: { local } }, pageHotkeys: 0 });
document.documentElement.style.fontSize = '10px';
document.addEventListener('keydown', () => {
  const globals = globalThis as typeof globalThis & { pageHotkeys: number };
  globals.pageHotkeys += 1;
});
const host = document.createElement('div');
host.style.cssText = 'width:min(420px,calc(100% - 32px));margin:24px auto';
document.querySelector('#preview')!.append(host);
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = css;
shadow.append(style);
const mount = document.createElement('div');
shadow.append(mount);

function Preview() {
  const [open, setOpen] = useState(true);
  const [attempt, setAttempt] = useState<PracticePanelProps['attempt']>('editing');
  const [result, setResult] = useState<PracticePanelProps['result']>(null);
  const [error, setError] = useState<PracticePanelProps['error']>(null);
  const [canResume, setCanResume] = useState(false);
  const close = () => setOpen(false);
  const grade = (mode: 'run' | 'submit', code: string) => {
    setAttempt('checking');
    setError(null);
    setTimeout(() => {
      if (code.includes('provider_error')) {
        setAttempt('failed'); setError({ code: 'GRADER_TIMEOUT', message: 'Grading timed out.', retryable: true }); return;
      }
      const passed = code.includes('**');
      setResult(passed ? { outcome: 'passed', passedCount: 1, totalCount: 1,
        results: [{ kind: 'visible', index: 0, passed: true, args: [2, 3], expected: 8, actual: 8 }] }
        : failed as PracticePanelProps['result']);
      setAttempt(passed && mode === 'submit' ? 'passed' : 'failed');
      if (passed && mode === 'submit') setCanResume(true);
    }, 250);
  };
  return <><Badge count={1} state="ready" onOpen={() => setOpen(true)} />
    <div style={{ height: 12 }} />
    {open && <PracticePanel videoId={fixture.videoId} revision={new URLSearchParams(location.search).get('revision') ?? fixture.revision}
      breakpoint={fixture.breakpoints[0]} attempt={attempt} result={result} error={error} canResume={canResume}
      onRun={code => grade('run', code)} onSubmit={code => grade('submit', code)}
      onSkip={close} onClose={close} onResume={close} />}
  </>;
}
createRoot(mount).render(<Preview />);
