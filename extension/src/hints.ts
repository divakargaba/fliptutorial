import { createContext } from 'react';
import type { AnalysisResponse, HintResponse, LastResult, WorkerReply } from './contracts';

/** Provided by the content script; the panel owns hint state and calls these. */
export const HintsContext = createContext<{
  requestHint(input: { code: string; level: number; lastResult?: LastResult; previousHints?: string[] }): Promise<WorkerReply<HintResponse>>;
} | null>(null);

/** Efficiency review of a passing submission, driven by the content script. */
export type AnalysisState =
  | { status: 'loading' }
  | { status: 'done'; data: AnalysisResponse }
  | { status: 'error' };
