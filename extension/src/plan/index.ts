// Lane A3 (@abdullahwarv2): plan client, pause scheduling by rank/frequency, learner controls,
// honest watch time and practice-event emission. Contract: src/v2/types.ts.
import type { ExercisePlan, PauseFrequency, PlanPause } from '../v2/types';

export function pausesFor(plan: ExercisePlan, frequency: PauseFrequency): PlanPause[] {
  const maxRank = frequency === 'few' ? 1 : frequency === 'normal' ? 2 : Infinity;
  if (!['planning', 'ready'].includes(plan.status) || !plan.verdict.qualifies) return [];
  const qualified = new Set(plan.sections.filter(s => s.qualifies).map(s => s.id));
  return plan.pauses.filter(p => qualified.has(p.sectionId) && p.ready && p.rank <= maxRank &&
    (p.kind === 'coding' ? p.exercise : p.question)).sort((a, b) => a.pauseAtS - b.pauseAtS);
}
