// Roadmap v2 contract types (lead-owned, frozen). Mirrors contracts/v2/README.md.
// Lanes import these; validation (Zod) lives in each lane's own module.

export type LevelId = string; // e.g. "beginner-1" … "expert-10" (contracts/v2/levels.json)
export type ConceptId = string; // contracts/v2/concepts.json
export type Language = 'python' | 'javascript' | 'typescript' | 'java' | 'cpp' | 'c' | 'csharp' | 'go' | 'rust' | 'sql' | 'pseudocode' | 'unknown';
export type Evidence = { startS: number; endS: number; text: string };

export type PlanExercise = {
  id: string; revision: string; title: string; language: Language; statement: string; starterCode: string;
  examples: { args: unknown[]; expected: unknown }[]; concepts: ConceptId[]; level: LevelId; aiGenerated: boolean;
};
export type PlanQuestion = {
  id: string; revision: string; title: string; style: 'multiple_choice' | 'short_answer' | 'predict_output';
  prompt: string; choices?: { id: string; text: string }[]; concepts: ConceptId[]; level: LevelId; aiGenerated: boolean;
};
export type PlanSection = {
  id: string; startS: number; endS: number; title: string; qualifies: boolean;
  format: 'code' | 'theory' | 'mixed' | 'off_topic'; language: Language; concepts: ConceptId[]; evidence: Evidence[];
};
export type PlanPause = {
  id: string; sectionId: string; pauseAtS: number; revealAtS: number | null; kind: 'coding' | 'concept';
  rank: number; ready: boolean; exercise?: PlanExercise | null; question?: PlanQuestion | null;
};
export type ExercisePlan = {
  schemaVersion: 2; videoId: string; planId: string; generatedAt: string; learnerLevel: LevelId;
  status: 'planning' | 'ready' | 'not_coding' | 'no_captions' | 'error';
  verdict: { qualifies: boolean; reason: string; evidence: Evidence[] };
  sections: PlanSection[]; pauses: PlanPause[];
};

export type Complexity = { time: string; space: string };
export type FeedbackResult = {
  schemaVersion: 2; exerciseId: string; outcome: 'passed' | 'failed'; concept: { id: ConceptId; name: string };
  assessedLevel: LevelId; summary: string; aiGenerated: boolean;
  success: null | { explanation: string; optimization: { show: boolean; learner: Complexity; best: Complexity; tip: string | null; betterSolution: string | null } };
  diagnosis: null | {
    misconception: { id: string; name: string; explanation: string };
    lines: { line: number; note: string }[];
    failingCase: null | { args: unknown[]; expected: unknown; actual: unknown; error: string | null };
  };
};

export type PracticeEvent = {
  id: string; accountId: string; at: string;
  type: 'watched' | 'practiced' | 'passed' | 'failed' | 'skipped' | 'hint_used' | 'refresher_answered';
  videoId?: string; exerciseId?: string; concepts?: ConceptId[]; level?: LevelId; attempts?: number; hintsUsed?: number;
  hintLevel?: number; optimal?: boolean; misconception?: string; correct?: boolean; watchedS?: [number, number];
};

export type PublicProfile = {
  schemaVersion: 2; accountId: string; displayName: string; public: boolean;
  skills: { concept: ConceptId; level: LevelId; levelName: string; xp: number; strength: number; lastPracticedAt: string; passed: number; tutorials: number }[];
  highlights: string[]; refresherDue: { concept: ConceptId; reason: string }[];
  topInDemand: { concept: ConceptId; reason: string; videoUrl: string }[];
  complements: { accountId: string; displayName: string; why: string }[];
};

export type PauseFrequency = 'few' | 'normal' | 'many';
