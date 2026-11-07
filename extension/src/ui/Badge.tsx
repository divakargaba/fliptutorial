import { Code2, LoaderCircle } from 'lucide-react';

export type BadgeProps = {
  count: number;
  state: 'loading' | 'ready' | 'unavailable';
  onOpen(): void;
};

export function Badge({ count, state, onOpen }: BadgeProps) {
  const ready = state === 'ready' && count > 0;
  return <button className="bp-badge inline-flex items-center gap-2" type="button"
    onClick={onOpen} disabled={!ready} aria-busy={state === 'loading'}>
    {state === 'loading' ? <LoaderCircle size={14} aria-hidden="true" /> : <Code2 size={14} aria-hidden="true" />}
    <span>Breakpoint · {state === 'loading' ? 'Loading practice' : state === 'unavailable'
      ? 'Practice unavailable' : `${count} ${count === 1 ? 'exercise' : 'exercises'}`}</span>
  </button>;
}
