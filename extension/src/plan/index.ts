// Lane A3 (@abdullahwarv2): plan client, pause scheduling by rank/frequency, learner controls,
// honest watch time and practice-event emission. Contract: src/v2/types.ts.
import type { ExercisePlan, PauseFrequency, PlanPause } from '../v2/types';

export function pausesFor(plan: ExercisePlan, frequency: PauseFrequency): PlanPause[] {
  const maxRank = frequency === 'few' ? 1 : frequency === 'normal' ? 2 : Infinity;
  return plan.pauses.filter(p => p.ready && p.rank <= maxRank && (p.exercise || p.question));
}
