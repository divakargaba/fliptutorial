import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import type { PlanPause } from '../v2/types';
import { formatTimestamp } from './format';
import { BrandMark } from './BrandMark';

export type TimelineChallengesProps = {
  /** Already validated pauses eligible under the runtime's current settings. */
  pauses: readonly PlanPause[];
  durationS: number;
  /** Pause ids, not exercise ids. Skipped challenges remain absent. */
  passedIds?: ReadonlySet<string>;
  onOpen(pauseId: string): void;
};

function readyPauses(pauses: readonly PlanPause[], durationS: number) {
  if (!Number.isFinite(durationS) || durationS <= 0) return [];
  return pauses.filter(pause => pause.ready && Number.isFinite(pause.pauseAtS) && pause.pauseAtS >= 0 && pause.pauseAtS <= durationS &&
    (pause.kind === 'coding' ? !!pause.exercise : !!pause.question)).sort((a, b) => a.pauseAtS - b.pauseAtS);
}
export type TimelineMarker = {
  id: string; timeS: number; position: number; title: string; kind: 'coding' | 'concept';
  concepts: string[]; status: 'upcoming' | 'attempted' | 'passed';
};
export type TimelineMarkersProps = { markers: TimelineMarker[]; onSelect(id: string): void };
function label(item: TimelineMarker) {
  return `${item.title} · ${item.concepts.map(concept => concept.replaceAll('-', ' ')).join(', ')} · ${formatTimestamp(item.timeS)} · ${item.status === 'passed' ? 'Passed' : item.status === 'attempted' ? 'Unfinished · Attempted' : 'Unfinished'}`;
}

/** A3 owns placement by the scrubber, seeking, reopening, and completion/event guards. */
export function TimelineChallenges({ pauses, durationS, passedIds = new Set(), onOpen }: TimelineChallengesProps) {
  return <TimelineMarkers markers={readyPauses(pauses, durationS).map(pause => {
    const item = (pause.kind === 'coding' ? pause.exercise : pause.question)!;
    return { id: pause.id, timeS: pause.pauseAtS, position: pause.pauseAtS / durationS * 100,
      title: item.title, kind: pause.kind, concepts: item.concepts, status: passedIds.has(pause.id) ? 'passed' : 'upcoming' };
  })} onSelect={onOpen} />;
}

/** Runtime-facing interface agreed with A3; runtime supplies only ready validated items. */
export function TimelineMarkers({ markers, onSelect }: TimelineMarkersProps) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(420);
  const [cluster, setCluster] = useState<string[] | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0]!.contentRect.width));
    if (track.current) observer.observe(track.current);
    return () => observer.disconnect();
  }, []);
  const ready = markers.filter(marker => Number.isFinite(marker.position) && Number.isFinite(marker.timeS) && marker.timeS >= 0)
    .map(marker => ({ ...marker, position: Math.max(0, Math.min(100, marker.position)) })).sort((a, b) => a.position - b.position);
  const groups: TimelineMarker[][] = [];
  for (const pause of ready) {
    const previous = groups.at(-1);
    if (previous && (pause.position - previous[0]!.position) / 100 * Math.max(0, width - 32) < 36) previous.push(pause);
    else groups.push([pause]);
  }
  return <div className="bp-v2 bp-timeline-challenges">
    <div ref={track} className="bp-challenge-track" role="group" aria-label="Challenge timeline">
      {groups.map(group => {
        const first = group[0]!;
        const passed = group.every(pause => pause.status === 'passed');
        const description = group.length === 1 ? label(first) : `${group.length} challenges near ${formatTimestamp(first.timeS)}`;
        return <button type="button" key={first.id} className="bp-timeline-marker" data-passed={passed}
          style={{ left: `calc(16px + (100% - 32px) * ${first.position / 100})` }}
          title={description} aria-label={description} aria-expanded={group.length > 1 ? group.some(pause => cluster?.includes(pause.id)) : undefined}
          onClick={() => group.length === 1 ? onSelect(first.id) : setCluster(group.map(pause => pause.id))}>
          <span className="bp-bulb" aria-hidden="true">💡</span>{passed && <Check className="bp-bulb-check" size={12} aria-hidden="true" />}
          {group.length > 1 && <span>{group.length}</span>}
        </button>;
      })}
    </div>
    {cluster && <div className="bp-v2-card" role="group" aria-label="Nearby challenges">
      <ChallengeList markers={ready.filter(pause => cluster.includes(pause.id))} onSelect={onSelect} />
      <button type="button" onClick={() => setCluster(null)}>Close nearby challenges</button>
    </div>}
    <details className="bp-challenge-disclosure"><summary><span className="bp-logo-inline"><BrandMark size={14} /></span>Challenges ({ready.length})</summary>
      {ready.length ? <ChallengeList markers={ready} onSelect={onSelect} /> : <p>No challenges ready yet.</p>}
    </details>
  </div>;
}

function ChallengeList({ markers, onSelect }: TimelineMarkersProps) {
  return <ol className="bp-challenge-list">{markers.map(pause => <li key={pause.id}>
    <button type="button" title={label(pause)} onClick={() => onSelect(pause.id)}>
      <span className="bp-bulb" aria-hidden="true">💡</span>{pause.status === 'passed' && <Check size={12} aria-hidden="true" />}
      <span><strong>{pause.title}</strong><small>{formatTimestamp(pause.timeS)} · {pause.status === 'passed' ? 'Passed · Review' : pause.status === 'attempted' ? 'Unfinished · Try again' : 'Unfinished · Practice'}</small></span>
    </button>
  </li>)}</ol>;
}
