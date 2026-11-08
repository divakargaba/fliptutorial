import { z } from 'zod';
import { HintResponseSchema, LastResultSchema, SubmissionResponseSchema, VideoIdSchema } from '../contracts';

const id = z.string().min(1).max(200);
const time = z.number().finite().nonnegative();
export const LevelSchema = z.string().regex(/^(beginner|intermediate|advanced|expert)-[1-9][0-9]?$/);
const language = z.enum(['python', 'javascript', 'typescript', 'java', 'cpp', 'c', 'csharp', 'go', 'rust', 'sql', 'pseudocode', 'unknown']);
const evidence = z.object({ startS: time, endS: time, text: z.string() }).strict();
const exercise = z.object({
  id, revision: id, title: id, language, statement: z.string().min(1), starterCode: z.string(),
  examples: z.array(z.object({ args: z.array(z.json()), expected: z.json() }).strict()),
  concepts: z.array(id).min(1), level: LevelSchema, aiGenerated: z.boolean(),
}).strict();
const question = z.object({
  id, revision: id, title: id, style: z.enum(['multiple_choice', 'short_answer', 'predict_output']),
  prompt: z.string().min(1), choices: z.array(z.object({ id, text: z.string() }).strict()).optional(),
  concepts: z.array(id).min(1), level: LevelSchema, aiGenerated: z.boolean(),
}).strict();
// B1 returns the same public question contract as the planner, never its answer.
// Null represents HTTP 204 (no skill is due), not a failed request.
export const RefresherSchema = z.object({
  accountId: id, concept: id, conceptName: z.string().min(1),
  strength: z.number().min(0).max(1), reason: z.string(), question,
}).strict().refine(r => r.question.concepts.includes(r.concept), 'Refresher concept mismatch').nullable();
export type Refresher = NonNullable<z.infer<typeof RefresherSchema>>;
export const ExercisePlanSchema = z.object({
  schemaVersion: z.literal(2), videoId: VideoIdSchema, planId: id, generatedAt: z.string(), learnerLevel: LevelSchema,
  status: z.enum(['planning', 'ready', 'not_coding', 'no_captions', 'error']),
  verdict: z.object({ qualifies: z.boolean(), reason: z.string(), evidence: z.array(evidence) }).strict(),
  sections: z.array(z.object({ id, startS: time, endS: time, title: z.string(), qualifies: z.boolean(),
    format: z.enum(['code', 'theory', 'mixed', 'off_topic']), language, concepts: z.array(id), evidence: z.array(evidence),
  }).strict()),
  pauses: z.array(z.object({ id, sectionId: id, pauseAtS: time, revealAtS: time.nullable(),
    kind: z.enum(['coding', 'concept']), rank: z.number().int().positive(), ready: z.boolean(),
    exercise: exercise.nullable().optional(), question: question.nullable().optional(),
  }).strict()),
}).strict().superRefine((plan, ctx) => {
  const sections = new Map(plan.sections.map(s => [s.id, s]));
  const ids = new Set<string>();
  if (sections.size !== plan.sections.length || plan.sections.some(s => s.endS <= s.startS)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid section boundaries or duplicate sections' });
  }
  plan.pauses.forEach((p, i) => {
    const s = sections.get(p.sectionId);
    if (ids.has(p.id) || !s || p.pauseAtS < s.startS || p.pauseAtS > s.endS ||
        (p.revealAtS !== null && p.revealAtS <= p.pauseAtS) ||
        (p.ready && !(p.kind === 'coding' ? p.exercise && !p.question : p.question && !p.exercise))) {
      ctx.addIssue({ code: 'custom', path: ['pauses', i], message: 'Invalid pause or missing matching content' });
    }
    ids.add(p.id);
  });
});

const complexity = z.object({ time: z.string(), space: z.string() }).strict();
export const FeedbackSchema = z.object({
  schemaVersion: z.literal(2), exerciseId: id, outcome: z.enum(['passed', 'failed']),
  concept: z.object({ id, name: z.string() }).strict(), assessedLevel: LevelSchema, summary: z.string(), aiGenerated: z.boolean(),
  success: z.object({ explanation: z.string(), optimization: z.object({ show: z.boolean(), learner: complexity,
    best: complexity, tip: z.string().nullable(), betterSolution: z.string().nullable() }).strict() }).strict().nullable(),
  diagnosis: z.object({ misconception: z.object({ id, name: z.string(), explanation: z.string() }).strict(),
    lines: z.array(z.object({ line: z.number().int().positive(), note: z.string() }).strict()),
    failingCase: z.object({ args: z.array(z.json()), expected: z.json(), actual: z.json(), error: z.string().nullable() }).strict().nullable(),
  }).strict().nullable(),
}).strict().refine(r => r.outcome === 'passed' ? r.success !== null && r.diagnosis === null
  : r.success === null && r.diagnosis !== null, 'Feedback must match its outcome');
export const SubmitResultSchema = z.object({ grade: SubmissionResponseSchema, feedback: FeedbackSchema }).strict()
  .refine(r => (r.grade.outcome === 'passed') === (r.feedback.outcome === 'passed'), 'Conflicting feedback verdict');
export const AnswerResultSchema = z.object({ correct: z.boolean(), feedback: FeedbackSchema }).strict()
  .refine(r => r.correct === (r.feedback.outcome === 'passed'), 'Conflicting answer verdict');
export const PracticeEventSchema = z.object({
  id, accountId: id, at: z.string().datetime(),
  type: z.enum(['watched', 'practiced', 'passed', 'failed', 'skipped', 'hint_used', 'refresher_answered']),
  videoId: VideoIdSchema.optional(), exerciseId: id.optional(), concepts: z.array(id).optional(), level: LevelSchema.optional(),
  attempts: z.number().int().nonnegative().optional(), hintsUsed: z.number().int().nonnegative().optional(),
  hintLevel: z.number().int().min(0).max(3).optional(), optimal: z.boolean().optional(), misconception: id.optional(),
  correct: z.boolean().optional(), watchedS: z.tuple([time, time]).optional(),
}).strict().refine(e => e.type !== 'watched' || (!!e.videoId && !!e.watchedS && e.watchedS[1] > e.watchedS[0]), 'Invalid watched interval');
const code = z.string().refine(s => new TextEncoder().encode(s).length <= 16384, 'Code exceeds 16 KiB');
export const PlanMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan'), videoId: VideoIdSchema, learnerLevel: LevelSchema,
    learnerLevels: z.record(id, LevelSchema).optional() }).strict(),
  z.object({ type: z.literal('pollPlan'), videoId: VideoIdSchema }).strict(),
  z.object({ type: z.literal('submitV2'), exerciseId: id, revision: id, language, code: code.refine(s => !!s.trim()),
    mode: z.enum(['run', 'submit']), learnerLevel: LevelSchema }).strict(),
  z.object({ type: z.literal('answerV2'), questionId: id, revision: id, answer: z.string().min(1).max(16384), learnerLevel: LevelSchema }).strict(),
  z.object({ type: z.literal('hintV2'), exerciseId: id, revision: id, code, hintLevel: z.number().int().min(0).max(3),
    learnerLevel: LevelSchema, lastResult: LastResultSchema.optional() }).strict(),
  z.object({ type: z.literal('levelV2'), accountId: id, concept: id }).strict(),
  z.object({ type: z.literal('levelsV2'), accountId: id }).strict(),
  z.object({ type: z.literal('refresherV2'), accountId: id, concept: id.optional() }).strict(),
  z.object({ type: z.literal('awardV2'), accountId: id, eventId: id }).strict(),
  z.object({ type: z.literal('eventsV2'), events: z.array(PracticeEventSchema).min(1).max(100) }).strict(),
]);
export type PlanMessage = z.infer<typeof PlanMessageSchema>;
export const responseSchemas = {
  plan: ExercisePlanSchema, pollPlan: ExercisePlanSchema, submitV2: SubmitResultSchema,
  answerV2: AnswerResultSchema, hintV2: HintResponseSchema,
};
