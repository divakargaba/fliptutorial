import { createContext, useContext } from 'react';
import { Check, PanelBottom, PanelRight, Sparkles } from 'lucide-react';
import type { PracticeLayout } from './workspace-preference';

export const WorkspaceContext = createContext<{
  layout: PracticeLayout; effectiveLayout: PracticeLayout; saving?: boolean;
  onChange(layout: PracticeLayout): void;
  onPauseVideo?(): void;
} | null>(null);

export function LayoutSwitch() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) return null;
  return <div className="bp-layout-switch" role="group" aria-label="Practice placement">
    {([{ value: 'side', label: 'Side', Icon: PanelRight }, { value: 'below', label: 'Below', Icon: PanelBottom }] as const).map(({ value, label, Icon }) =>
      <button type="button" key={value} aria-pressed={workspace.layout === value} disabled={workspace.saving}
        title={value === 'side' && workspace.effectiveLayout !== 'side' && workspace.layout === 'side' ? 'Side preferred; below fits this window' : `${label === 'Side' ? 'Beside' : 'Below'} the video`}
        onClick={() => workspace.onChange(value)}><Icon size={14} aria-hidden="true" /><span>{label}</span></button>)}
  </div>;
}

/** Decorative only: no timers, playback callbacks or progress writes. */
export function SuccessCelebration() {
  return <div className="bp-celebration" aria-hidden="true">
    <span className="bp-celebration-check"><Check size={30} strokeWidth={2.5} /></span>
    <Sparkles className="bp-celebration-spark is-left" size={19} />
    <Sparkles className="bp-celebration-spark is-right" size={15} />
  </div>;
}
