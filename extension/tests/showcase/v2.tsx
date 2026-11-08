import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import css from '../../src/ui/theme.css?inline';
import { ConceptQuestionPanel, FeedbackCard, LearnerSettings, LevelUp, RefresherPrompt, TopicNotAvailable, defaultSettings } from '../../src/ui/v2';
import { ProfilePage, ProfileView } from '../../src/profile-ui';
import { PracticePanel } from '../../src/ui/PracticePanel';
import { TimelineChallenges } from '../../src/ui/TimelineChallenges';
import practice from '../../../contracts/practice-response.fixture.json';
import type { Breakpoint } from '../../src/contracts';
import type { ExercisePlan, FeedbackResult, Language, PlanQuestion, PublicProfile } from '../../src/v2/types';
import plan from '../../../contracts/v2/exercise-plan.fixture.json';
import failed from '../../../contracts/v2/feedback-result.failed.fixture.json';
import passed from '../../../contracts/v2/feedback-result.passed.fixture.json';
import profile from '../../../contracts/v2/public-profile.fixture.json';
import { PRACTICE_LAYOUT_KEY, readPracticeLayout, type PracticeLayout } from '../../src/ui/workspace-preference';
import { ACCOUNT_KEY, SETTINGS_KEY, readAccount, readSettings } from '../../src/plan/settings';

// The preview has no extension context; production uses A3's browser helpers.
const previewPreferences = {
  async loadPracticeLayout() { return readPracticeLayout(localStorage.getItem(PRACTICE_LAYOUT_KEY)); },
  async savePracticeLayout(value: PracticeLayout) { localStorage.setItem(PRACTICE_LAYOUT_KEY, value); },
  async loadActiveAccount() { return readAccount(JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? 'null')); },
  async loadLearnerSettings() { return readSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') ?? undefined); },
  async setActiveAccount(value: string) { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(value)); },
  async saveLearnerSettings(value: typeof defaultSettings) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)); },
};

const params = new URLSearchParams(location.search);
const state = params.get('state') ?? 'question';
if (state === 'profile-demo') {
  const demoFields = ['Energy data analytics', 'Cybersecurity', 'Data science & AI'].map((name, index) => ({
    id: `field-${index}`, name, summary: 'Build practical skills through short coding exercises.', rising: true,
    postings: { calgary: [40, 17, 28][index], alberta: 60, canada: [80, 204, 120][index], count: 60, where: 'Calgary', scope: 'city', searchUrl: 'https://www.adzuna.ca/search', titleContains: name },
    skills: (index === 0 ? ['Excel', 'SQL', 'Power BI', 'Python'] : index === 1 ? ['Networking', 'Azure', 'Python'] : ['Python', 'SQL', 'Machine learning']).map(name => ({ name, tracked: name === 'Python', level: null })),
    alsoAskedFor: [], tutorials: index === 0 ? [{ url: 'https://www.youtube.com/watch?v=samplevid01', title: 'Time Series Forecasting with XGBoost · Predict energy consumption', codingChallenges: 4, firstChallenge: { atS: 327, title: 'Extract the hour from a timestamp' } }] : [],
  }));
  globalThis.fetch = async input => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    const data = path.endsWith('/accounts') ? [{ accountId: 'test-ana', displayName: 'Ana (test)' }] : path.includes('/skills/fields') ? { pulledAt: '2026-11-08', sources: [], fields: demoFields } : profile;
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
}
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
Object.assign(globalThis, { chrome: { storage: { local: {
  async get(keys: string | string[]) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, JSON.parse(localStorage.getItem(key) ?? 'null')])); },
  async set(values: Record<string, unknown>) { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value)); },
} } }, pageHotkeys: 0 });
document.addEventListener('keydown', () => { (globalThis as typeof globalThis & { pageHotkeys: number }).pageHotkeys++; });
document.body.style.background = theme === 'dark' ? '#0f0f0f' : '#fafafa';
const host = document.querySelector('#root')!;
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style'); style.textContent = css; shadow.append(style);
const mount = document.createElement('div'); mount.className = 'breakpoint-shell'; mount.dataset.theme = theme;
mount.style.cssText = `width:min(${state.startsWith('profile') ? (state === 'profile-demo' ? '400' : '600') : '460'}px,calc(100% - 32px));margin:24px auto`;
shadow.append(mount);
const code = 'def raise_to_power(base_num, pow_num):\n    result = 1\n    while pow_num > 0:\n        result *= base_num\n    return result';
function Showcase() {
  const [settings, setSettings] = useState(defaultSettings);
  const [dismissed, setDismissed] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackResult | null>(state === 'question-passed' ? passed as FeedbackResult : null);
  const [checking, setChecking] = useState(state === 'question-checking');
  const [action, setAction] = useState('');
  const [accountId, setAccountId] = useState('test-ana');
  if (state === 'timeline') {
    const pauses = (plan as ExercisePlan).pauses.map((pause, index) => ({ ...pause, pauseAtS: 1000 + index * 20 }));
    return <><TimelineChallenges durationS={10000} pauses={[
      ...pauses,
      { ...pauses[0]!, id: 'nearby', pauseAtS: pauses[0]!.pauseAtS + 10 },
      { ...pauses[0]!, id: 'later', pauseAtS: 9000 },
      { ...pauses[0]!, id: 'not-ready', ready: false, pauseAtS: 8000 },
      { ...pauses[0]!, id: 'missing-exercise', exercise: null, pauseAtS: 7000 },
    ]} passedIds={new Set(['later'])} onOpen={setAction} /><output aria-label="Opened challenge">{action}</output></>;
  }
  if (state === 'profile-live' || state === 'profile-demo') return <ProfilePage preferences={previewPreferences} />;
  if (state === 'profile') return <ProfileView profile={profile as PublicProfile} />;
  if (state === 'coding-language' || state === 'coding-accounts') {
    const language = (params.get('language') ?? 'javascript') as Language;
    const starterCode = language === 'sql' ? 'SELECT true;' : language === 'java' ? 'class Main {\n}' : language === 'cpp' ? 'int main() {\n}' : 'function solution(value) {\n  return value;\n}';
    return <><label>Draft account<select aria-label="Draft account" value={accountId} onChange={event => setAccountId(event.target.value)}><option value="test-ana">Ana</option><option value="test-ben">Ben</option></select></label>
      <PracticePanel videoId={practice.videoId} revision={practice.revision} accountId={accountId} language={language}
        breakpoint={{ ...practice.breakpoints[0]! as Breakpoint, exercise: { ...(practice.breakpoints[0]! as Breakpoint).exercise, starterCode, examples: [{ args: [true, null], expected: false }] } }}
        attempt="editing" result={null} error={null} canResume={false} ownsPause={true}
        onRun={setAction} onSubmit={setAction} onSkip={() => {}} onClose={() => {}} onResume={() => {}} />
      <output aria-label="Submitted source">{action}</output></>;
  }
  if (state === 'coding-level' || state === 'coding-passed') return <PracticePanel videoId={practice.videoId} revision={practice.revision} breakpoint={practice.breakpoints[0]! as Breakpoint}
    attempt={state === 'coding-passed' ? 'passed' : 'editing'} result={null} error={null} canResume={false} ownsPause={true} manualResume={state === 'coding-passed'}
    conceptLevels={[{ concept: 'loops', level: 'beginner-2' }]} levelUp={{ concept: 'loops', level: 'beginner-2' }}
    feedback={state === 'coding-passed' ? { result: passed as FeedbackResult, submittedCode: code } : null}
    onRun={() => {}} onSubmit={() => {}} onSkip={() => {}} onClose={() => {}} onResume={() => {}} />;
  if (state === 'failed') return <FeedbackCard feedback={failed as FeedbackResult} code={code} />;
  if (state === 'passed' || state === 'beginner-passed') return <FeedbackCard feedback={state === 'passed' ? passed as FeedbackResult : { ...passed, assessedLevel: 'beginner-2', success: { ...passed.success, optimization: { ...passed.success.optimization, show: false } } } as FeedbackResult} code={code} />;
  if (state === 'level-up') return <LevelUp concept="loops" level="beginner-2" />;
  if (state === 'settings') return <LearnerSettings value={settings} videoId="rfscVS0vtbw" onChange={setSettings} />;
  if (state === 'unavailable') return dismissed ? <p>Dismissed</p> : <TopicNotAvailable reason="This video discusses careers rather than teaching code." onDismiss={() => setDismissed(true)} />;
  if (state === 'refresher') return <>{!dismissed && <RefresherPrompt due={profile.refresherDue} onDismiss={() => setDismissed(true)} onStart={setAction} />}<p role="status">{action}</p></>;
  const question: PlanQuestion = { ...(plan as ExercisePlan).pauses[1]!.question!, ...(state === 'short' ? { style: 'short_answer', choices: undefined } : state === 'predict' ? { style: 'predict_output', choices: undefined } : {}) };
  return <><ConceptQuestionPanel question={question} feedback={state === 'question-resume-error' ? passed as FeedbackResult : feedback} checking={checking}
    error={state === 'question-error' ? { code: 'NETWORK', message: 'Connection failed.', retryable: true } : null} canResume={state === 'question-resume-error'} onAnswer={answer => {
    setAction(answer); setChecking(true); setTimeout(() => { setChecking(false); setFeedback(answer === 'c' || answer === '3' ? passed as FeedbackResult : failed as FeedbackResult); }, 200);
  }} onSkip={() => setAction('skip')} onClose={() => setAction('close')} onResume={() => setAction('resume')} /><output aria-label="Last action">{action}</output></>;
}
createRoot(mount).render(<Showcase />);
