import { useEffect, useId, useRef, useState } from 'react';
import { ACTIVE_ACCOUNT_KEY, DEFAULT_SETTINGS, SETTINGS_KEY as FROZEN_SETTINGS_KEY, type FeedbackResult, type LevelId, type LearnerSettings as Settings, type PauseFrequency, type PlanQuestion, type PublicProfile } from '../../v2/types';
import levels from '../../../../contracts/v2/levels.json';
import concepts from '../../../../contracts/v2/concepts.json';
import { FeedbackEditor } from './FeedbackEditor';
import { PracticeMore } from '../PracticeMore';
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

export type ConceptQuestionPanelProps = {
  question: PlanQuestion; feedback: FeedbackResult | null; checking: boolean;
  error?: { code: string; message: string; retryable: boolean } | null; canResume?: boolean;
  onAnswer(answer: string): void; onSkip(): void; onResume(): void; onClose(): void;
};
export function ConceptQuestionPanel(props: ConceptQuestionPanelProps) {
  return <QuestionForm key={`${props.question.id}/${props.question.revision}`} {...props} />;
}
function QuestionForm({ question, feedback, checking, error, canResume, onAnswer, onSkip, onResume, onClose }: ConceptQuestionPanelProps) {
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
    <header className="bp-v2-header"><span>Concept practice</span><button type="button" onClick={onClose} aria-label="Close practice">Close</button></header>
    <div className="bp-v2-body"><h2 id={title} ref={heading} tabIndex={-1}>{question.title}</h2>
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
        {feedback && <FeedbackCard feedback={feedback} code="" />}
        <div className="bp-v2-actions"><PracticeMore onLater={onSkip} />
          {passed ? <button type="button" className="bp-v2-primary" onClick={onResume}>Resume video</button>
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
    {feedback.success && <p>{feedback.success.explanation}</p>}
    {optimization?.show && <details><summary>Improve your solution</summary>
      <p>Your solution: {optimization.learner.time} time · {optimization.learner.space} space</p>
      <p>Target: {optimization.best.time} time · {optimization.best.space} space</p>
      {optimization.tip && <p>{optimization.tip}</p>}{optimization.betterSolution && <pre>{optimization.betterSolution}</pre>}
    </details>}
    {feedback.diagnosis && <><h4>{feedback.diagnosis.misconception.name}</h4><p>{feedback.diagnosis.misconception.explanation}</p>
      {code && <FeedbackEditor code={code} lines={feedback.diagnosis.lines} />}
      <ul>{feedback.diagnosis.lines.map((item, index) => <li key={`${item.line}/${index}`}>Line {item.line}: {item.note}</li>)}</ul>
      {feedback.diagnosis.failingCase && <details><summary>Failing example</summary><pre>{JSON.stringify(feedback.diagnosis.failingCase, null, 2)}</pre></details>}</>}
    {feedback.aiGenerated && <small>AI-generated feedback</small>}
  </section>;
}

export type NotAvailableProps = { reason: string; onDismiss(): void };
export function TopicNotAvailable({ reason, onDismiss }: NotAvailableProps) {
  return <section className="bp-v2 bp-v2-card" aria-label="Topic not available"><h2>Topic not available</h2><p>{reason}</p><p>Keep watching. Practice will appear on a supported coding topic.</p><button onClick={onDismiss}>Dismiss</button></section>;
}
export function RefresherPrompt({ due, onStart, onDismiss }: {
  due: PublicProfile['refresherDue']; onStart(concept: string): void; onDismiss(): void;
}) {
  if (!due.length) return null;
  const first = due[0]!;
  return <aside className="bp-v2 bp-v2-card" aria-label="Skill refresher"><h2>A quick refresher?</h2><p>Keep {conceptName(first.concept)} fresh with a short question.</p><p>{first.reason}</p>
    <div className="bp-v2-actions"><button onClick={onDismiss}>Later</button><button className="bp-v2-primary" onClick={() => onStart(first.concept)}>Start refresher</button></div></aside>;
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
