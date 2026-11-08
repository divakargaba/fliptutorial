import { useContext, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { WorkspaceContext } from './workspace';

/** Leaving practice never implies completion; the runtime owns the skip event. */
export function PracticeMore({ onLater, onOpen }: { onLater(): void; onOpen?(): void }) {
  const workspace = useContext(WorkspaceContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <div className="bp-more" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="bp-skip" aria-expanded={open} onClick={() => { if (!open) onOpen?.(); setOpen(value => !value); }}>
      <MoreHorizontal size={16} aria-hidden="true" />More
    </button>
    {open && <div className="bp-more-options"><button type="button" className="bp-button bp-secondary" onClick={onLater}>Practice later</button>
      <p className="bp-note">Keep watching. This challenge stays unfinished.</p>{workspace?.onPauseVideo && <button type="button" className="bp-button bp-secondary" onClick={() => { workspace.onPauseVideo?.(); setOpen(false); }}>Turn off practice for this video</button>}</div>}
  </div>;
}
