// Lane B2 (@reyanshBadhwar26): v2 panel views. Lane A3 mounts these from the content script.
// Stubs only; props are the frozen contract.
import type { FeedbackResult, PlanQuestion } from '../../v2/types';

export type ConceptQuestionPanelProps = {
  question: PlanQuestion; feedback: FeedbackResult | null; checking: boolean;
  onAnswer(answer: string): void; onSkip(): void; onResume(): void; onClose(): void;
};
export function ConceptQuestionPanel(_props: ConceptQuestionPanelProps) { return null; }

export type FeedbackCardProps = { feedback: FeedbackResult; code: string };
export function FeedbackCard(_props: FeedbackCardProps) { return null; }

export type NotAvailableProps = { reason: string; onDismiss(): void };
export function TopicNotAvailable(_props: NotAvailableProps) { return null; }
