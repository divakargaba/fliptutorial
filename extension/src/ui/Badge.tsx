import { Check, CircleAlert, LoaderCircle, RotateCw, SquareCode } from 'lucide-react';
import { formatTimestamp } from './format';

export type BadgeProps = {
  state: 'loading' | 'ready' | 'unavailable';
  /** Breakpoints in this video. */
  total: number;
  /** Not yet opened, skipped or solved in this watch session. */
  remaining: number;
  /** Solved in this watch session. */
  solved: number;
  /** A practice panel is currently open. */
  active: boolean;
  /** Pause time of the next remaining breakpoint. */
  nextAtS: number | null;
  onOpen(): void;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Always one <button> element so React keeps the same DOM node (and focus) across states.
export function Badge({ state, total, remaining, solved, active, nextAtS, onOpen }: BadgeProps) {
  let kind: string; let label: string; let icon; let text: string; let meta: React.ReactNode = null;
  if (state === 'loading') {
    kind = 'loading'; label = 'Breakpoint · finding practice'; text = 'Finding practice…';
    icon = <LoaderCircle size={15} className="bp-spin" aria-hidden="true" />;
  } else if (state === 'unavailable') {
    kind = 'unavailable'; label = 'Breakpoint · practice unavailable, retry'; text = 'Practice unavailable';
    icon = <CircleAlert size={15} aria-hidden="true" />;
    meta = <><RotateCw size={13} aria-hidden="true" />Retry</>;
  } else if (active) {
    kind = 'active'; label = 'Breakpoint · practicing now'; text = 'Practicing now';
    icon = <span className="bp-live-dot" aria-hidden="true" />;
    if (total > 1) meta = `${total - remaining} of ${total}`;
  } else if (remaining > 0) {
    kind = 'ready';
    label = `Breakpoint · ${plural(remaining, 'challenge')}${nextAtS !== null ? ` at ${formatTimestamp(nextAtS)}` : ''}`;
    text = remaining === total ? plural(total, 'challenge') : `${plural(remaining, 'challenge')} left`;
    icon = <SquareCode size={15} aria-hidden="true" />;
    if (nextAtS !== null) meta = `at ${formatTimestamp(nextAtS)}`;
  } else {
    kind = solved > 0 ? 'solved' : 'done'; label = `Breakpoint · ${solved} of ${total} solved`;
    text = solved === total ? (total === 1 ? 'Challenge solved' : 'All challenges solved') : `${solved} of ${total} solved`;
    icon = solved > 0 ? <Check size={15} className="bp-pass" aria-hidden="true" /> : <SquareCode size={15} aria-hidden="true" />;
  }
  const clickable = kind === 'ready' || kind === 'unavailable';
  return <button type="button" className="bp-badge" data-state={kind} aria-label={label}
    aria-disabled={!clickable || undefined} aria-busy={kind === 'loading' || undefined}
    title={kind === 'ready' ? 'Open the next challenge now' : undefined}
    onClick={clickable ? onOpen : undefined}>
    {icon}<span>{text}</span>{meta !== null && <span className="bp-badge-meta">{meta}</span>}
  </button>;
}
