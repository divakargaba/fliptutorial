import { LayoutSwitch, SuccessCelebration } from '../workspace';
import { useEffect, useId, useRef, useState } from 'react';
import { ACTIVE_ACCOUNT_KEY, DEFAULT_SETTINGS, SETTINGS_KEY as FROZEN_SETTINGS_KEY, type FeedbackResult, type LevelId, type LearnerSettings as Settings, type PauseFrequency, type PlanQuestion, type PublicProfile } from '../../v2/types';
import levels from '../../../../contracts/v2/levels.json';
import concepts from '../../../../contracts/v2/concepts.json';
import { FeedbackEditor } from './FeedbackEditor';
import { PracticeMore } from '../PracticeMore';
import { BrandMark } from '../BrandMark';
export { TimelineMarkers } from '../TimelineChallenges';
export type { TimelineMarker, TimelineMarkersProps } from '../TimelineChallenges';

export const levelName = (id: LevelId) => levels.levels.find(level => level.id === id)?.name ?? id;
export const conceptName = (id: string) => concepts.concepts.find(concept => concept.id === id)?.name ?? id;
export function LevelChip({ concept, level }: { concept: string; level: LevelId }) {
  return <span className="bp-v2-chip">{conceptName(concept)} · {levelName(level)}</span>;
}
export function LevelUp({ concept, level }: { concept: string; level: LevelId }) {
  return <p className="bp-v2 bp-v2-levelup" role="status">Level up! {conceptName(concept)} · {levelName(level)}</p>;
}

// What one practice event earned (GET /v2/profile/{accountId}/award/{eventId}, lane B1).
export type AwardLevel = { level: LevelId; levelName: string; rank: number; minXp: number };
export type AwardItem = {
  concept: string; conceptName: string; primary: boolean; xpGained: number; xpBefore: number; xp: number;
  levelBefore: AwardLevel; level: AwardLevel; nextLevel: AwardLevel | null; xpToNext: number; progress: number; leveledUp: boolean;
};
export type Award = { accountId: string; eventId: string; type: string; totalXpGained: number; leveledUp: boolean; awards: AwardItem[] };

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const share = (xp: number, lv: AwardLevel, next: AwardLevel | null) =>
  next && next.minXp > lv.minXp ? Math.max(0, Math.min(1, (xp - lv.minXp) / (next.minXp - lv.minXp))) : 1;

function ProgressRow({ item, delayMs }: { item: AwardItem; delayMs: number }) {
  // Animate from where the learner was in this level (0 after a level-up) to where they are now.
  const from = item.leveledUp ? 0 : share(item.xpBefore, item.level, item.nextLevel);
  const [width, setWidth] = useState(reducedMotion() ? item.progress : from);
  useEffect(() => {
    if (reducedMotion()) return;
    const timer = setTimeout(() => setWidth(item.progress), 60 + delayMs);
    return () => clearTimeout(timer);
  }, [item.progress, delayMs]);
  const known = conceptName(item.concept);
  const name = known !== item.concept ? known : item.conceptName || item.concept;
  const gained = Math.round(item.xpGained);
  return <li className="bp-v2-progress-row" style={{ listStyle: 'none', margin: item.primary ? '10px 0 0' : '8px 0 0', fontSize: item.primary ? 14 : 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
      <strong style={{ fontWeight: item.primary ? 600 : 500 }}>{name} <span className="bp-v2-chip" style={{ marginBottom: 0 }}>{item.level.levelName}</span></strong>
      <span style={{ color: 'var(--bp-pass)', fontWeight: 600, whiteSpace: 'nowrap' }}>{gained > 0 ? `+${gained} XP` : '+0 XP'}</span>
    </div>
    <div aria-hidden="true" style={{ height: item.primary ? 8 : 6, borderRadius: 99, background: 'var(--bp-chip)', overflow: 'hidden', marginTop: 6 }}>
      <span style={{ display: 'block', height: '100%', width: `${Math.max(width * 100, 2)}%`, borderRadius: 99, background: 'var(--bp-pass)',
        transition: `width 900ms var(--bp-ease-out, ease-out) ${delayMs}ms` }} />
    </div>
    <progress className="sr-only" aria-label={`${name} progress to the next level`} value={item.progress} max={1} />
    <small style={{ display: 'block', marginTop: 4, color: 'var(--bp-text-2, inherit)' }}>
      {Math.floor(item.xp)} XP · {item.nextLevel ? `${Math.ceil(item.xpToNext)} XP to ${item.nextLevel.levelName}` : 'Max level'}
    </small>
    {item.leveledUp && <LevelUp concept={item.concept} level={item.level.level} />}
  </li>;
}

/** Duolingo-style "what you just earned" card shown after a pass or a correct answer. */
export function ProgressCard({ award }: { award: Award }) {
  const items = [...award.awards].sort((a, b) => Number(b.primary) - Number(a.primary));
  const total = Math.round(award.totalXpGained);
  return <section className="bp-v2 bp-v2-card bp-v2-progress" aria-label="Your progress" role="status" style={{ padding: 12 }}>
    <p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--bp-pass)' }}>+{total} XP</p>
    <ul style={{ padding: 0, margin: 0 }}>{items.map((item, i) => <ProgressRow key={item.concept} item={item} delayMs={i * 120} />)}</ul>
  </section>;
}

export type ConceptQuestionPanelProps = {
  resumeLabel?: string;
  positionLabel?: string;
  question: PlanQuestion; feedback: FeedbackResult | null; checking: boolean;
  error?: { code: string; message: string; retryable: boolean } | null; canResume?: boolean;
  progress?: Award | null;
  onAnswer(answer: string): void; onSkip(): void; onResume(): void; onClose(): void;
};
export function ConceptQuestionPanel(props: ConceptQuestionPanelProps) {
  return <QuestionForm key={`${props.question.id}/${props.question.revision}`} {...props} />;
}
function QuestionForm({ question, feedback, checking, error, canResume, progress, onAnswer, onSkip, onResume, onClose, resumeLabel = 'Resume video', positionLabel }: ConceptQuestionPanelProps) {
  const [answer, setAnswer] = useState('');
  const title = useId();
  const group = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const root = heading.current?.getRootNode();
    const previous = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    heading.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const passed = feedback?.outcome === 'passed';
  return <section className="bp-v2 bp-panel" aria-labelledby={title}
    onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onKeyPress={event => event.stopPropagation()}>
    <header className="bp-v2-header"><span className="bp-brand-row"><BrandMark size={16} />Concept practice</span><LayoutSwitch /><button type="button" onClick={onClose} aria-label="Close practice">Close</button></header>
    <div className="bp-v2-body">{positionLabel && <p className="bp-step">{positionLabel}</p>}<h2 id={title} ref={heading} tabIndex={-1}>{question.title}</h2>
      <div className="bp-v2-chips">{question.concepts.map(concept => <LevelChip key={concept} concept={concept} level={question.level} />)}</div>
      {question.aiGenerated && <small>AI-generated practice</small>}<p className="bp-v2-prompt">{question.prompt}</p>
      <form onSubmit={event => { event.preventDefault(); if (answer.trim() && !checking && !passed) onAnswer(answer.trim()); }}>
        <fieldset disabled={checking || passed}><legend>{question.style === 'multiple_choice' ? 'Choose an answer' : question.style === 'predict_output' ? 'Predict the output' : 'Your answer'}</legend>
          {question.style === 'multiple_choice' ? question.choices?.map(choice => <label className="bp-v2-choice" key={choice.id}>
            <input type="radio" name={group} value={choice.id} checked={answer === choice.id} onChange={() => setAnswer(choice.id)} />{choice.text}</label>)
            : <textarea aria-label={question.style === 'predict_output' ? 'Predicted output' : 'Your answer'} rows={4} maxLength={8000} value={answer} onChange={event => setAnswer(event.target.value)} />}
        </fieldset>
        {error && <p role="alert">{error.message}{error.retryable ? ' Try your answer again, or skip and watch.' : ' Skip and watch to continue.'}</p>}
        {canResume && <p role="status">The browser didn’t resume playback. Try Resume video again.</p>}
        {passed && <SuccessCelebration />}
        {feedback && <FeedbackCard feedback={feedback} code="" />}
        {passed && progress && <ProgressCard award={progress} />}
        <div className="bp-v2-actions"><PracticeMore onLater={onSkip} />
          {passed ? <button type="button" className="bp-v2-primary" onClick={onResume}>{resumeLabel}</button>
            : <button className="bp-v2-primary" disabled={checking || !answer.trim()}>{checking ? 'Checking…' : 'Check answer'}</button>}</div>
        <span role="status">{checking ? 'Checking your answer' : ''}</span>
      </form></div></section>;
}

export type FeedbackCardProps = { feedback: FeedbackResult; code: string };
export function FeedbackCard({ feedback, code }: FeedbackCardProps) {
  const optimization = feedback.success?.optimization;
  return <section className="bp-v2 bp-v2-feedback" aria-label="Practice feedback" aria-live="polite">
    <LevelChip concept={feedback.concept.id} level={feedback.assessedLevel} />
    <h3>{feedback.outcome === 'passed' ? 'Well done' : 'Try again'}</h3><p>{feedback.summary}</p>
    {feedback.success && feedback.success.explanation.trim() !== feedback.summary.trim() && <p>{feedback.success.explanation}</p>}
    {optimization?.show && <details><summary>Improve your solution</summary>
      <p>Your solution: {optimization.learner.time} time · {optimization.learner.space} space</p>
      <p>Target: {optimization.best.time} time · {optimization.best.space} space</p>
      {optimization.tip && <p>{optimization.tip}</p>}{optimization.betterSolution && <pre>{optimization.betterSolution}</pre>}
    </details>}
    {feedback.diagnosis && <><h4>{feedback.diagnosis.misconception.name}</h4>
      {feedback.diagnosis.misconception.explanation.trim() !== feedback.summary.trim() && <p>{feedback.diagnosis.misconception.explanation}</p>}
      {code && <FeedbackEditor code={code} lines={feedback.diagnosis.lines} />}
      <ul>{feedback.diagnosis.lines.map((item, index) => <li key={`${item.line}/${index}`}>Line {item.line}: {item.note}</li>)}</ul>
      {feedback.diagnosis.failingCase && <details><summary>Failing example</summary><pre>{JSON.stringify(feedback.diagnosis.failingCase, null, 2)}</pre></details>}</>}
    {feedback.aiGenerated && <small>AI-generated feedback</small>}
  </section>;
}

export type NotAvailableProps = { reason: string; onDismiss(): void };
export function TopicNotAvailable({ reason, onDismiss }: NotAvailableProps) {
  return <section className="bp-v2 bp-v2-card" aria-label="Topic not available"><h2 className="bp-brand-row"><BrandMark size={18} />Topic not available</h2><p>{reason}</p><p>Keep watching. Practice will appear on a supported coding topic.</p><button onClick={onDismiss}>Dismiss</button></section>;
}
export function RefresherPrompt({ due, onStart, onDismiss }: {
  due: PublicProfile['refresherDue']; onStart(concept: string): void; onDismiss(): void;
}) {
  if (!due.length) return null;
  const first = due[0]!;
  return <aside className="bp-v2 bp-refresher" aria-label="Skill refresher">
      <span className="bp-refresher-icon" aria-hidden="true">💡</span><div><h2>Refresh {conceptName(first.concept)}</h2><p>One quick question</p></div>
      <div className="bp-refresher-actions"><button onClick={onDismiss}>Later</button><button className="bp-v2-primary" onClick={() => onStart(first.concept)}>Practice</button></div></aside>;
}
export type LearnerSettingsValue = Settings;
export const SETTINGS_KEY = FROZEN_SETTINGS_KEY;
export const ACCOUNT_KEY = ACTIVE_ACCOUNT_KEY;
export const defaultSettings: LearnerSettingsValue = DEFAULT_SETTINGS;
export function LearnerSettings({ value, videoId, onChange }: { value: LearnerSettingsValue; videoId?: string; onChange(value: LearnerSettingsValue): void }) {
  return <section className="bp-v2 bp-v2-card" aria-label="Practice settings"><h2>Practice settings</h2>
    <label className="bp-v2-choice"><input type="checkbox" checked={value.autoPause} onChange={event => onChange({ ...value, autoPause: event.target.checked })} />Automatically pause for practice</label>
    <label className="bp-v2-setting">Pause frequency<select value={value.frequency} onChange={event => onChange({ ...value, frequency: event.target.value as PauseFrequency })}>
      <option value="few">Few</option><option value="normal">Normal</option><option value="many">Many</option></select></label>
    {videoId && <label className="bp-v2-choice"><input type="checkbox" checked={value.disabledVideos.includes(videoId)} onChange={event => onChange({ ...value, disabledVideos: event.target.checked ? [...new Set([...value.disabledVideos, videoId])] : value.disabledVideos.filter(id => id !== videoId) })} />Never pause on this video</label>}
  </section>;
}
