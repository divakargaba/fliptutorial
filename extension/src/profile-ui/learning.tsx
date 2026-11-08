import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Download, Play, RotateCcw, Trash2, BookOpen } from 'lucide-react';
import { listSolutions, deleteSolution, solutionUrl, type SavedSolution } from '../learning/local';
import { requestPlanApi } from '../plan/api';
import { AnswerResultSchema, RefresherSchema, type Refresher } from '../plan/schemas';
import { ConceptQuestionPanel } from '../ui/v2';
import type { FeedbackResult } from '../v2/types';
import { formatTimestamp } from '../ui/format';

export function useHistory(account: string) {
  const [rows, setRows] = useState<SavedSolution[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    type ChangeListener = (values: Record<string, unknown>, area: string) => void;
    const changes = (globalThis as typeof globalThis & { chrome?: { storage?: { onChanged?: { addListener(listener: ChangeListener): void; removeListener(listener: ChangeListener): void } } } }).chrome?.storage?.onChanged;
    const changed = (values: Record<string, unknown>, area: string) => {
      if (area === 'local' && Object.keys(values).some(key => key.startsWith(`breakpoint:history:${encodeURIComponent(account)}/`))) setRevision(n => n + 1);
    };
    changes?.addListener(changed);
    return () => changes?.removeListener(changed);
  }, [account]);
  useEffect(() => { let current = true; setRows([]); setError('');
    void listSolutions(account).then(data => { if (current) setRows(data); }).catch(() => { if (current) setError('Local history is unavailable. Your profile is still available.'); });
    return () => { current = false; };
  }, [account, revision]);
  return { rows, error, refresh: () => setRevision(n => n + 1) };
}
export function HistoryList({ rows, onSelect }: { rows: SavedSolution[]; onSelect(row: SavedSolution): void }) {
  return rows.length ? <ul className="bp-learning-history">{rows.map(row => <li key={row.id}>
    <button type="button" onClick={() => onSelect(row)}><span className="bp-learning-video-icon"><Play size={17} /></span><span><strong>{row.title}</strong><small>{row.videoTitle} · {formatTimestamp(row.timestampS)}</small><small>{new Date(row.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · Passed</small></span></button>
  </li>)}</ul> : <div className="bp-learning-empty"><BookOpen size={24} /><strong>Your learning trail starts here</strong><p>Passing submissions will appear here with your video and solution. Earlier drafts are kept, but are not treated as verified solutions.</p></div>;
}
export function SolutionDetail({ row, onBack, onDeleted }: { row: SavedSolution; onBack(): void; onDeleted(): void }) {
  const [confirm, setConfirm] = useState(false); const [error, setError] = useState('');
  const download = () => {
    const blob = new Blob([JSON.stringify(row, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
    link.download = `breakpoint-solution-${row.id.slice(0, 8)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="bp-learning-detail" aria-label="Saved solution">
    <button className="bp-pf-back" onClick={onBack}><ArrowLeft size={16} />Back</button>
    <h1>{row.title}</h1><span className="bp-learning-pass"><Check size={14} />Passed</span>
    <p className="bp-pf-body">{row.videoTitle}</p><p className="bp-pf-caption">{formatTimestamp(row.timestampS)} · {new Date(row.savedAt).toLocaleDateString()} · {row.language}</p>
    <h2>Your submitted code</h2><pre className="bp-learning-code" tabIndex={0}><code>{row.code}</code></pre>
    <p className="bp-pf-sub">{row.attempts} {row.attempts === 1 ? 'attempt' : 'attempts'} this session · {row.hints} {row.hints === 1 ? 'hint' : 'hints'}</p>
    <p className="bp-learning-privacy">Stored on this browser only. Separate from your current draft.</p>
    <div className="bp-learning-actions"><a className="bp-pf-primary" href={solutionUrl(row)} target="_blank" rel="noreferrer"><Play size={16} />Watch moment</a><a className="bp-pf-ghost" href={solutionUrl(row, true)} target="_blank" rel="noreferrer"><RotateCcw size={15} />Practice again</a></div>
    <div className="bp-learning-actions"><button className="bp-pf-ghost" onClick={() => setConfirm(true)}><Trash2 size={15} />Delete</button><button className="bp-pf-ghost" onClick={download}><Download size={15} />Export</button></div>
    {confirm && <div className="bp-learning-confirm" role="alert"><p>Delete this saved solution? Your draft and XP stay unchanged.</p><button onClick={() => void deleteSolution(row.accountId, row.id).then(onDeleted).catch(() => setError('Could not delete this solution.'))}>Delete solution</button><button onClick={() => setConfirm(false)}>Keep it</button></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
export function SkillReview({ accountId, concept, level, onBack }: { accountId: string; concept: string; level: string; onBack(): void }) {
  const [pick, setPick] = useState<Refresher | null>(null); const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<FeedbackResult | null>(null); const [checking, setChecking] = useState(false);
  const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const live = useRef(true); const locked = useRef(false);
  const base = import.meta.env.WXT_API_BASE_URL || 'http://127.0.0.1:8000';
  useEffect(() => { live.current = true; let current = true; setLoading(true); setError('');
    void requestPlanApi({ type: 'refresherV2', accountId, concept }, base).then(reply => {
      if (!current) return;
      if (!reply.ok) setError(reply.error.error.message);
      else { const parsed = RefresherSchema.safeParse(reply.data); setPick(parsed.success ? parsed.data : null); }
      setLoading(false);
    });
    return () => { current = false; live.current = false; };
  }, [accountId, concept, retry]);
  const answer = async (answer: string) => {
    if (!pick || locked.current || feedback?.outcome === 'passed') return;
    locked.current = true; setChecking(true); setError('');
    const reply = await requestPlanApi({ type: 'answerV2', questionId: pick.question.id, revision: pick.question.revision, answer, learnerLevel: level }, base);
    if (!live.current) return;
    if (!reply.ok) setError(reply.error.error.message);
    else { const parsed = AnswerResultSchema.safeParse(reply.data); if (parsed.success) setFeedback(parsed.data.feedback); else setError('Could not read the answer result.'); }
    locked.current = false; setChecking(false);
    // Deliberate review is educational only. Never enqueue practice/XP events.
  };
  return <section className="bp-learning-review" aria-label="Skill review">
    <button className="bp-pf-back" onClick={onBack}><ArrowLeft size={16} />Back</button>
    <p className="bp-learning-privacy">Review practice · no XP changes</p>
    {loading ? <p role="status">Preparing your review…</p> : pick ? <ConceptQuestionPanel question={pick.question} feedback={feedback} checking={checking} error={error ? { code: 'REVIEW', message: error, retryable: true } : null} onAnswer={answer} onClose={onBack} onSkip={onBack} onResume={onBack} resumeLabel="Done" />
      : <div className="bp-learning-empty"><p>{error || 'No review question is available for this skill yet. You can revisit a saved lesson below.'}</p><button className="bp-pf-ghost" onClick={() => setRetry(n => n + 1)}>Retry</button></div>}
  </section>;
}
