import { createContext } from 'react';
import type { ApiError } from './contracts';

// Consumed by the Test Me UI inside the extension's shadow root.
export const TestMeContext = createContext<{
  canStart: boolean;
  request: { status: 'loading' } | { status: 'error'; error: ApiError['error'] } | null;
  aiGenerated: boolean;
  onStart(): void;
  onRetry(): void;
  onClose(): void;
} | null>(null);
