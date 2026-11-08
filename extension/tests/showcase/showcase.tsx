// Design showcase: a mock YouTube watch page with the real Breakpoint components in any state.
// Run: node node_modules/vite/bin/vite.js --config tests/e2e/vite.preview.config.ts
// Open: http://127.0.0.1:4173/tests/showcase/index.html?state=editing&theme=dark
// States: ready, editing, checking, failed, examples, error, solved
import { createRoot } from 'react-dom/client';
import css from '../../src/ui/theme.css?inline';
import { Badge } from '../../src/ui/Badge';
import { PracticePanel, type PracticePanelProps } from '../../src/ui/PracticePanel';
import type { AnalysisResponse, Breakpoint, HintResponse, SubmissionResponse, WorkerReply } from '../../src/contracts';
import { HintsContext } from '../../src/hints';

const q = new URLSearchParams(location.search);
const state = q.get('state') ?? 'editing';
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
Object.assign(globalThis, { chrome: { storage: { local: {
  async get() { return {}; }, async set() {},
} } } });

const breakpoint: Breakpoint = {
  id: 'exponent', pauseAtS: 9803.32, revealAtS: 9805.32,
  exercise: {
    id: 'rfscVS0vtbw-exponent', title: 'Raise a number to a power', language: 'python',
    statement: 'Write raise_to_power(base_num, pow_num) that returns base_num raised to the power pow_num. base_num is an integer and pow_num is a nonnegative integer. Use a loop instead of the ** operator or pow().',
    starterCode: 'def raise_to_power(base_num, pow_num):\n    pass\n',
    examples: [{ args: [2, 3], expected: 8 }, { args: [3, 2], expected: 9 }],
  },
};
const wrong: SubmissionResponse = { outcome: 'wrong_answer', passedCount: 1, totalCount: 2, results: [
  { kind: 'visible', index: 0, passed: true, args: [2, 3], expected: 8, actual: 8, diagnostic: null },
  { kind: 'visible', index: 1, passed: false, args: [3, 2], expected: 9, actual: 6, diagnostic: null },
] };
const examples: SubmissionResponse = { outcome: 'passed', passedCount: 2, totalCount: 2, results: wrong.results.map(r => (r.kind === 'visible' ? { ...r, passed: true, actual: r.expected } : r)) };
const solved: SubmissionResponse = { outcome: 'passed', passedCount: 8, totalCount: 8, results: [
  ...examples.results, ...Array.from({ length: 6 }, (_, i) => ({ kind: 'hidden' as const, index: i + 2, passed: true })),
] };
const slow: AnalysisResponse = {
  learner: { time: 'O(n)', space: 'O(1)' }, best: { time: 'O(log n)', space: 'O(1)' }, optimal: false,
  summary: 'You passed! Your loop multiplies pow_num times, but squaring lets you halve the work each step.',
  tip: 'Square the base and halve the exponent each step (exponentiation by squaring).',
  betterSolution: 'def raise_to_power(base_num, pow_num):\n    result = 1\n    while pow_num > 0:\n        if pow_num % 2 == 1:\n            result *= base_num\n        base_num *= base_num\n        pow_num //= 2\n    return result\n',
  aiGenerated: true,
};
const HINTS: HintResponse[] = [
  { level: 1, maxLevel: 3, feedback: null, focus: 'repeated multiplication', aiGenerated: true, sources: [],
    hint: 'Raising to a power means multiplying the base by itself again and again. How many times should that happen?' },
  { level: 2, maxLevel: 3, feedback: null, focus: 'range()', aiGenerated: true,
    sources: [{ title: 'range()', url: 'https://docs.python.org/3/library/stdtypes.html#range' }],
    hint: 'A for loop over range(pow_num) runs exactly pow_num times; keep a running result that starts at 1.' },
  { level: 3, maxLevel: 3, feedback: null, focus: 'outline', aiGenerated: true, sources: [],
    hint: '1. Start a result at 1. 2. Repeat pow_num times. 3. Each time, multiply the result by base_num. 4. Give the result back.' },
];
const hintsStub = {
  async requestHint(input: { level: number }): Promise<WorkerReply<HintResponse>> {
    await new Promise(r => setTimeout(r, 150));
    if (input.level === 0) return { ok: true as const, data: { ...HINTS[0]!, level: 0, hint: null, sources: [],
      feedback: 'For raise_to_power(3, 2) your function returned 6, but 9 is expected, so it is multiplying base by exponent once instead of repeating the multiplication.' } };
    return { ok: true as const, data: HINTS[input.level - 1]! };
  },
};
const props: Record<string, Partial<PracticePanelProps>> = {
  editing: { attempt: 'editing' },
  checking: { attempt: 'checking' },
  failed: { attempt: 'failed', result: wrong },
  examples: { attempt: 'editing', result: examples },
  error: { attempt: 'failed', error: { code: 'GRADER_UNAVAILABLE', message: 'The grader is unavailable right now.', retryable: true } },
  solved: { attempt: 'passed', result: solved, holdMs: 60_000, analysis: { status: 'done', data: {
    learner: { time: 'O(n)', space: 'O(1)' }, best: { time: 'O(n)', space: 'O(1)' }, optimal: true,
    summary: 'Efficient.', tip: null, betterSolution: null, aiGenerated: true } } },
  'solved-slow': { attempt: 'passed', result: solved, holdMs: 60_000, analysis: { status: 'done', data: slow } },
  'solved-checking': { attempt: 'passed', result: solved, holdMs: 60_000, analysis: { status: 'loading' } },
};
const dark = theme === 'dark';
document.body.style.cssText = `margin:0;background:${dark ? '#0f0f0f' : '#fff'};font-family:Roboto,Arial,sans-serif`;

function Page() {
  const panel = state !== 'ready';
  return <div style={{ display: 'flex', gap: 24, padding: '24px 24px 0 24px', maxWidth: 1754, margin: '0 auto' }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ aspectRatio: '16/9', borderRadius: 12, background: dark ? '#000' : '#111', position: 'relative', overflow: 'hidden',
        backgroundImage: 'linear-gradient(135deg,#1d2b3a,#0b0f14)' }}>
        <pre style={{ position: 'absolute', left: '8%', top: '18%', margin: 0, color: '#cfe3ff', font: '500 22px/1.6 "Roboto Mono", monospace', opacity: .9 }}>
{`# Exponent Function
def raise_to_power(base_num, pow_num):
    result = 1
    for index in range(pow_num):
        `}<span style={{ opacity: .35 }}>█</span></pre>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, background: 'rgba(255,255,255,.2)' }}>
          <div style={{ width: '61%', height: '100%', background: '#f00' }} />
        </div>
        {panel && <div style={{ position: 'absolute', left: 16, bottom: 18, color: '#fff', font: '500 13px Roboto', opacity: .9 }}>❚❚ 2:43:23 / 4:26:51</div>}
      </div>
      <h1 style={{ font: '700 20px/28px Roboto', color: dark ? '#f1f1f1' : '#0f0f0f', margin: '12px 0 0' }}>
        Learn Python - Full Course for Beginners [Tutorial]</h1>
      <p style={{ font: '14px Roboto', color: dark ? '#aaa' : '#606060', margin: '6px 0 0' }}>freeCodeCamp.org · 48M views</p>
    </div>
    <div style={{ width: 402, flexShrink: 0 }} id="secondary">
      <Shell />
      {[0, 1, 2].map(i => <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ width: 168, height: 94, borderRadius: 8, background: dark ? '#272727' : '#e5e5e5' }} />
        <div style={{ flex: 1 }}><div style={{ height: 12, width: '90%', borderRadius: 4, background: dark ? '#272727' : '#e5e5e5', marginBottom: 8 }} />
          <div style={{ height: 10, width: '60%', borderRadius: 4, background: dark ? '#222' : '#eee' }} /></div>
      </div>)}
    </div>
  </div>;
}

function Shell() {
  const host = (el: HTMLDivElement | null) => {
    if (!el || el.shadowRoot) return;
    const shadow = el.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = css; shadow.append(style);
    const mount = document.createElement('div'); mount.className = 'breakpoint-shell'; mount.dataset.theme = theme;
    mount.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding-bottom:16px';
    shadow.append(mount);
    const panel = state !== 'ready';
    createRoot(mount).render(<>
      <Badge state="ready" total={1} remaining={panel ? 0 : 1} solved={0} active={panel} nextAtS={breakpoint.pauseAtS} onOpen={() => {}} />
      {panel && <div style={{ width: '100%' }}><HintsContext.Provider value={hintsStub}><PracticePanel videoId="rfscVS0vtbw" revision="demo" breakpoint={breakpoint}
        attempt="editing" result={null} error={null} canResume={false}
        onRun={() => {}} onSubmit={() => {}} onSkip={() => {}} onResume={() => {}} onClose={() => {}} {...props[state]} /></HintsContext.Provider></div>}
    </>);
  };
  return <div ref={host} />;
}
createRoot(document.querySelector('#app')!).render(<Page />);
