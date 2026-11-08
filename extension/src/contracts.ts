import { z } from 'zod';

export const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const text = z.string().min(1);
const time = z.number().finite().nonnegative();
export const ExerciseSchema = z.object({
  id: text, title: text, statement: text, language: z.literal('python'),
  starterCode: z.string(),
  examples: z.array(z.object({ args: z.array(z.json()), expected: z.json() }).strict()).min(1),
}).strict();
export const TestMeResponseSchema = z.object({
  setId: text, generated: z.literal(true), aiGenerated: z.literal(true), exercise: ExerciseSchema,
}).strict();
export const BreakpointSchema = z.object({
  id: text, pauseAtS: time, revealAtS: time, exercise: ExerciseSchema,
}).strict().refine(b => b.pauseAtS < b.revealAtS, 'Pause must precede reveal');
export const PracticeResponseSchema = z.discriminatedUnion('status', [
  z.object({ schemaVersion: z.literal(1), videoId: VideoIdSchema, revision: text,
    status: z.literal('ready'), breakpoints: z.array(BreakpointSchema).min(1) }).strict(),
  z.object({ schemaVersion: z.literal(1), videoId: VideoIdSchema, revision: z.null(),
    status: z.literal('unsupported'), breakpoints: z.array(BreakpointSchema).length(0) }).strict(),
]).superRefine((data, ctx) => {
  const ids = new Set<string>();
  const exercises = new Set<string>();
  data.breakpoints.forEach((b, i) => {
    if (ids.has(b.id) || exercises.has(b.exercise.id) ||
        (i > 0 && data.breakpoints[i - 1]!.revealAtS > b.pauseAtS)) {
      ctx.addIssue({ code: 'custom', path: ['breakpoints', i], message: 'Breakpoints must be unique, sorted and nonoverlapping' });
    }
    ids.add(b.id); exercises.add(b.exercise.id);
  });
});
const VisibleResultSchema = z.object({
  kind: z.literal('visible'), index: z.number().int().nonnegative(), passed: z.boolean(),
  args: z.array(z.json()).optional(), expected: z.json().optional(), actual: z.json().optional(),
  diagnostic: z.string().nullable().optional(),
}).strict();
const HiddenResultSchema = z.object({
  kind: z.literal('hidden'), index: z.number().int().nonnegative(), passed: z.boolean(),
}).strict();
export const SubmissionResponseSchema = z.object({
  outcome: z.enum(['passed', 'wrong_answer', 'syntax_error', 'runtime_error', 'time_limit', 'invalid_output']),
  passedCount: z.number().int().nonnegative(), totalCount: z.number().int().positive(),
  results: z.array(z.discriminatedUnion('kind', [VisibleResultSchema, HiddenResultSchema])),
}).strict().superRefine((data, ctx) => {
  if (data.results.length !== data.totalCount ||
      data.results.filter(row => row.passed).length !== data.passedCount ||
      (data.outcome === 'passed') !== (data.passedCount === data.totalCount)) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent grading verdict' });
  }
});
export const ApiErrorSchema = z.object({
  error: z.object({ code: text, message: text, retryable: z.boolean() }).strict(),
  requestId: text,
}).strict();
export const GradeMessageSchema = z.object({
  type: z.literal('grade'), exerciseId: text, revision: text,
  mode: z.enum(['run', 'submit']), code: z.string().refine(
    code => code.trim().length > 0 && new TextEncoder().encode(code).length <= 16 * 1024,
    'Enter Python code of at most 16 KiB',
  ),
}).strict();
const OutcomeFailSchema = z.enum(['wrong_answer', 'syntax_error', 'runtime_error', 'time_limit', 'invalid_output']);
export const LastResultSchema = z.object({
  outcome: OutcomeFailSchema, args: z.array(z.json()).optional(), expected: z.json().optional(),
  actual: z.json().optional(), diagnostic: z.string().max(4000).nullable().optional(),
}).strict();
export const HintMessageSchema = z.object({
  type: z.literal('hint'), exerciseId: text, revision: text, code: z.string().max(16384),
  level: z.number().int().min(0).max(3), lastResult: LastResultSchema.optional(),
  previousHints: z.array(z.string().max(400)).max(6).optional(),
}).strict();
export const AnalyzeMessageSchema = z.object({
  type: z.literal('analyze'), exerciseId: text, revision: text, code: z.string().min(1).max(16384),
}).strict();
export const HintResponseSchema = z.object({
  level: z.number().int().min(0).max(3), maxLevel: z.number().int().positive(),
  feedback: z.string().nullable(), hint: z.string().nullable(), focus: z.string(),
  sources: z.array(z.object({ title: text, url: z.string().url().refine(u => u.startsWith('https://'), 'https only') }).strict()),
  aiGenerated: z.boolean(),
}).strict();
const ComplexitySchema = z.object({ time: text, space: text }).strict();
export const AnalysisResponseSchema = z.object({
  learner: ComplexitySchema, best: ComplexitySchema, optimal: z.boolean(), summary: text,
  tip: z.string().nullable(), betterSolution: z.string().nullable(), aiGenerated: z.boolean(),
}).strict();
export const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lookup'), videoId: VideoIdSchema }).strict(),
  GradeMessageSchema,
  z.object({ type: z.literal('testMe'), videoId: VideoIdSchema, timestampS: time }).strict(),
  HintMessageSchema,
  AnalyzeMessageSchema,
]);

export type Breakpoint = z.infer<typeof BreakpointSchema>;
export type PracticeResponse = z.infer<typeof PracticeResponseSchema>;
export type TestMeResponse = z.infer<typeof TestMeResponseSchema>;
export type HintResponse = z.infer<typeof HintResponseSchema>;
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;
export type LastResult = z.infer<typeof LastResultSchema>;
export type SubmissionResponse = z.infer<typeof SubmissionResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
export type GradeMessage = z.infer<typeof GradeMessageSchema>;
export type WorkerReply<T> = { ok: true; data: T } | { ok: false; error: ApiError };
export type AttemptState = 'idle' | 'editing' | 'checking' | 'failed' | 'passed';
export type PracticePanelProps = {
  videoId: string; revision: string; breakpoint: Breakpoint; attempt: AttemptState;
  result: SubmissionResponse | null; error: ApiError['error'] | null; canResume: boolean;
  onRun(code: string): void; onSubmit(code: string): void; onSkip(): void;
  onResume(): void; onClose(): void;
};
export type BadgeProps = { count: number; state: 'loading' | 'ready' | 'unavailable'; onOpen(): void };
