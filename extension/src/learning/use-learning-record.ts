import { useEffect, useRef, useState } from 'react';
import { attemptScope, completedAttempts, recordAttempt, saveSolution } from './local';
import type { PracticePanelProps } from '../ui/PracticePanel';

export function useLearningRecord(props: PracticePanelProps, hints: number) {
  const account = props.historyAccountId ?? props.accountId ?? 'legacy';
  const scope = attemptScope(account, props.videoId, props.breakpoint.exercise.id, props.revision);
  const stage = Math.min(hints, 2);
  const activeStage = useRef('');
  activeStage.current = `${scope}/${stage}`;
  const [effort, setEffort] = useState(0);
  const [notice, setNotice] = useState('');
  const pending = useRef<{ code: string; mode: 'run' | 'submit'; scope: string; stage: number } | null>(null);
  const attempts = useRef(0);
  const knownCodes = useRef(new Set<string>());
  const sessionEffort = useRef([0, 0, 0]);
  useEffect(() => {
    setNotice(''); pending.current = null;
    attempts.current = 0; knownCodes.current.clear(); sessionEffort.current = [0, 0, 0];
  }, [scope]);
  useEffect(() => {
    let live = true; setEffort(0);
    void completedAttempts(scope, undefined, stage).then(n => { if (live) setEffort(old => Math.max(old, n)); })
      .catch(() => { if (live) setEffort(sessionEffort.current[stage]!); });
    return () => { live = false; };
  }, [scope, stage]);
  useEffect(() => {
    if (props.attempt === 'checking' || props.leaving) return;
    if (props.error) { pending.current = null; return; }
    if (!props.result || !pending.current || pending.current.scope !== scope) return;
    const submitted = pending.current; pending.current = null;
    attempts.current++;
    if (submitted.code.trim() && submitted.code.trim() !== props.breakpoint.exercise.starterCode.trim()) {
      if (!knownCodes.current.has(submitted.code.trim())) sessionEffort.current[submitted.stage] = Math.min(2, sessionEffort.current[submitted.stage]! + 1);
      knownCodes.current.add(submitted.code.trim());
      const key = `${scope}/${submitted.stage}`;
      void recordAttempt(scope, submitted.code, undefined, submitted.stage).then(n => {
        if (activeStage.current === key) setEffort(old => Math.max(old, n));
      }).catch(() => {
        if (activeStage.current !== key) return;
        setEffort(sessionEffort.current[submitted.stage]!);
        setNotice('Hint unlock could not be saved. It remains available in this session.');
      });
    }
    if (submitted.mode === 'submit' && props.attempt === 'passed' && props.result.outcome === 'passed') {
      void saveSolution({ accountId: account, videoId: props.videoId, exerciseId: props.breakpoint.exercise.id,
        revision: props.revision, title: props.breakpoint.exercise.title, videoTitle: props.videoTitle || props.videoId,
        timestampS: props.breakpoint.pauseAtS, language: props.language ?? 'python', concepts: props.conceptLevels?.map(x => x.concept) ?? [],
        code: submitted.code, attempts: attempts.current, hints }).then(() => setNotice('Solution saved to local history.'))
        .catch(() => setNotice('Solution could not be saved locally. Copy your code before leaving.'));
    }
  }, [props.result, props.error, props.attempt, props.leaving]);
  return { effort, notice, begin: (mode: 'run' | 'submit', code: string) => { pending.current = { mode, code, scope, stage }; } };
}
