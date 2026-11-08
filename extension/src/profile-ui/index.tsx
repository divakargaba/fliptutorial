import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { ArrowLeft, BarChart3, ShieldCheck, Layers3, Check, ChevronDown, ChevronRight, Copy, ExternalLink, Info, Settings2, TrendingDown, TrendingUp, X } from 'lucide-react';
import { BrandMark } from '../ui/BrandMark';
import '@fontsource-variable/inter';
import type { PublicProfile } from '../v2/types';
import levels from '../../../contracts/v2/levels.json';
import { conceptName, defaultSettings, type LearnerSettingsValue } from '../ui/v2';
import { z } from 'zod';
import type { PracticeLayout } from '../ui/workspace-preference';
import { HistoryList, SolutionDetail, SkillReview, useHistory } from './learning';
import type { SavedSolution } from '../learning/local';

const accountSchema = z.object({ accountId: z.string().min(1), displayName: z.string(), public: z.boolean().optional() });
const profileSchema = z.object({
  schemaVersion: z.literal(2), accountId: z.string(), displayName: z.string(), public: z.boolean(),
  skills: z.array(z.object({ concept: z.string(), level: z.string(), levelName: z.string(), xp: z.number().nonnegative(), strength: z.number().min(0).max(1), lastPracticedAt: z.string(), passed: z.number().nonnegative(), tutorials: z.number().nonnegative() })),
  highlights: z.array(z.string()), refresherDue: z.array(z.object({ concept: z.string(), reason: z.string() })),
  topInDemand: z.array(z.object({ concept: z.string(), reason: z.string(), videoUrl: z.string() })),
  complements: z.array(z.object({ accountId: z.string(), displayName: z.string(), why: z.string() })),
});
export type LocalAccount = { accountId: string; displayName: string; public?: boolean };
type Preferences = Pick<typeof import('../plan/preferences'), 'loadLearnerSettings' | 'saveLearnerSettings' | 'loadActiveAccount' | 'setActiveAccount'> & Partial<Pick<typeof import('../ui/workspace-preference'), 'loadPracticeLayout' | 'savePracticeLayout'>>;
const preferences: Preferences = {
  loadPracticeLayout: async () => (await import('../ui/workspace-preference')).loadPracticeLayout(),
  savePracticeLayout: async value => (await import('../ui/workspace-preference')).savePracticeLayout(value),
  loadLearnerSettings: async () => (await import('../plan/preferences')).loadLearnerSettings(),
  saveLearnerSettings: async value => (await import('../plan/preferences')).saveLearnerSettings(value),
  loadActiveAccount: async () => (await import('../plan/preferences')).loadActiveAccount(),
  setActiveAccount: async value => (await import('../plan/preferences')).setActiveAccount(value),
};
let writeQueue = Promise.resolve();
function persist(save: () => Promise<void>) {
  const next = writeQueue.catch(() => {}).then(save);
  writeQueue = next;
  return next;
}
const base = (import.meta.env.WXT_API_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
function loadError(cause: unknown) {
  if (cause instanceof z.ZodError) return 'The local profile response could not be read. Update the backend and retry.';
  return cause instanceof Error ? cause.message : 'Could not load the local profile.';
}
async function get(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) }).catch(() => {
    throw new Error('Could not reach the local profile service. Check that the backend is running and retry.');
  });
  if (response.status === 404) throw new Error('This profile is private or does not exist.');
  if (!response.ok) throw new Error(response.status === 501 ? 'Profiles are not available yet. Try again when the local profile service is ready.' : 'Could not load the local profile. Check that the backend is running.');
  return response.json();
}
function safeVideo(url: string) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && ['www.youtube.com', 'youtube.com', 'youtu.be'].includes(parsed.hostname); } catch { return false; }
}

// ---------- registries ----------
/** Demo presentation: shows the "Viewing as" switcher and hides the "(test)" suffix. */
const DEMO_MODE = import.meta.env.WXT_DEMO_MODE !== 'false';
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const num = (value: number) => nf.format(Math.round(value));
const displayName = (name: string) => (DEMO_MODE ? name.replace(/\s*\(test\)\s*$/i, '') : name);
const firstName = (name: string) => displayName(name).split(' ')[0] ?? name;
/** The one place skill names come from. No colon names. */
const SKILL_NAMES: Record<string, string> = {
  loops: 'Loops', functions: 'Functions', conditionals: 'Conditionals', lists: 'Lists & arrays', 'sql-select': 'SQL queries', 'sql-joins': 'SQL joins',
  'http-apis': 'HTTP & APIs', 'react-components': 'React components', 'react-state': 'React state', 'js-dom': 'DOM & events', 'js-async': 'Async JavaScript',
  recursion: 'Recursion', 'dynamic-programming': 'Dynamic programming', trees: 'Trees', graphs: 'Graphs', dicts: 'Dictionaries', sets: 'Sets',
  'stacks-queues': 'Stacks & queues', 'linked-lists': 'Linked lists', heaps: 'Heaps', sorting: 'Sorting', searching: 'Searching', 'two-pointers': 'Two pointers',
  greedy: 'Greedy algorithms', complexity: 'Time & space complexity', oop: 'Classes & objects', functional: 'Functional programming', git: 'Git', testing: 'Testing',
  variables: 'Variables', types: 'Data types', operators: 'Operators', strings: 'Strings', io: 'Input & output', errors: 'Errors & exceptions',
};
const skillName = (id: string) => SKILL_NAMES[id] ?? conceptName(id).replace(/:\s*/, ' ');
/** Coarse topics for one-line summaries ("Brings React · You bring SQL"). */
const TOPIC: Record<string, string> = {
  'react-components': 'React', 'react-state': 'React', 'js-dom': 'JavaScript', 'js-async': 'JavaScript', 'sql-select': 'SQL', 'sql-joins': 'SQL', 'http-apis': 'APIs',
  recursion: 'algorithms', 'dynamic-programming': 'algorithms', greedy: 'algorithms', sorting: 'algorithms', searching: 'algorithms', 'two-pointers': 'algorithms',
  trees: 'data structures', graphs: 'data structures', lists: 'data structures', dicts: 'data structures', heaps: 'data structures', 'stacks-queues': 'data structures', 'linked-lists': 'data structures',
};
const AREA: Record<string, string> = { React: 'frontend', JavaScript: 'frontend', SQL: 'backend', APIs: 'backend', algorithms: 'algorithms', 'data structures': 'algorithms' };
const topicOf = (id: string) => TOPIC[id] ?? 'programming basics';
const ROMAN: Record<string, string> = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8', IX: '9', X: '10' };
const tierLabel = (levelName: string) => levelName.replace(/\b(X|IX|VIII|VII|VI|V|IV|III|II|I)$/, roman => ROMAN[roman] ?? roman);
const tierOf = (level: string) => (levels.levels.find(item => item.id === level) as { tier?: string } | undefined)?.tier ?? level.split('-')[0] ?? 'beginner';
const SOURCES: Record<string, string> = { 'react-state': 'Stack Overflow Developer Survey 2025', 'http-apis': 'Stack Overflow Developer Survey 2025', 'sql-joins': 'Stack Overflow Developer Survey 2025' };
const joinAnd = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const unique = <T,>(items: T[]) => [...new Set(items)];
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

type Skill = PublicProfile['skills'][number];
const rankOf = (level: string) => Math.max(0, levels.levels.findIndex(item => item.id === level));
const STRONG = 5; // Intermediate 1 and up
const byLevel = (a: Skill, b: Skill) => rankOf(b.level) - rankOf(a.level) || b.xp - a.xp;
export function progressFor(skill: Pick<Skill, 'level' | 'xp'>) {
  const index = rankOf(skill.level);
  const current = levels.levels[index]; const next = levels.levels[index + 1];
  const progress = current && next ? Math.max(0, Math.min(1, (skill.xp - current.minXp) / (next.minXp - current.minXp))) : 1;
  return { current, next, progress, left: next ? Math.max(0, next.minXp - skill.xp) : 0 };
}

// ---------- small parts ----------
const HUES = [212, 262, 152, 24, 330, 190, 48, 0];
function hueFor(id: string) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length] ?? 212; }
function Avatar({ id, name, size }: { id: string; name: string; size: 36 | 48 }) {
  const hue = hueFor(id);
  const letter = displayName(name).trim()[0]?.toUpperCase() ?? '?';
  return <span className="bp-pf-avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 70% 55% / .16)`, color: `hsl(${hue} 80% 72%)` }}>{letter}</span>;
}
function Tier({ level, levelName, suffix }: { level: string; levelName: string; suffix?: string }) {
  return <span className={`bp-pf-tier is-${tierOf(level)}`}><span className="bp-pf-dot" aria-hidden="true" />{tierLabel(levelName)}{suffix}</span>;
}
function Recall({ strength }: { strength: number }) {
  if (strength < 0.5) return <span className="bp-pf-recall is-fading"><TrendingDown size={14} aria-hidden="true" />Fading</span>;
  return <span className={`bp-pf-recall${strength >= 0.8 ? ' is-strong' : ''}`}>{Math.round(strength * 100)}%</span>;
}
function Meta({ parts }: { parts: string[] }) {
  return <p className="bp-pf-meta">{parts.map((part, index) => <span key={index}>{index ? `· ${part}` : part}</span>)}</p>;
}
function SectionLabel({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return <div className="bp-pf-label"><h2>{children}</h2>{end}</div>;
}

// ---------- skills ----------
function SkillRow({ skill, onSelect }: { skill: Skill; onSelect?(skill: Skill): void }) {
  const { next, progress, left } = progressFor(skill);
  const name = skillName(skill.concept);
  const pct = Math.round(progress * 100);
  const parts = [skill.passed > 0 ? `${num(skill.passed)} solved` : `Watched ${skill.tutorials} ${skill.tutorials === 1 ? 'tutorial' : 'tutorials'}`,
    `${num(skill.xp)} XP`, next ? `${num(left)} to ${tierLabel(next.name)}` : 'Max level', shortDate(skill.lastPracticedAt)];
  return <li className="bp-pf-skill">
    <div className="bp-pf-skill-top"><h3>{onSelect ? <button className="bp-skill-name" onClick={() => onSelect(skill)}>{name}<ChevronRight size={15} /></button> : name}</h3><Tier level={skill.level} levelName={skill.levelName} /><Recall strength={skill.strength} /></div>
    <div className="bp-pf-bar" role="progressbar" aria-label={`${name} level progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
      aria-valuetext={next ? `${pct}%, ${num(left)} XP to ${tierLabel(next.name)}` : 'Max level'} data-left={left}><span style={{ width: `${pct}%` }} /></div>
    <dl className="bp-learning-skill-stats"><div><dt>Solved</dt><dd>{num(skill.passed)}</dd></div><div><dt>XP</dt><dd>{num(skill.xp)}</dd></div></dl>
    <p className="bp-learning-next">{next ? `${num(left)} XP to ${tierLabel(next.name)}` : 'Highest level reached'}<span>Practiced {shortDate(skill.lastPracticedAt)}</span></p>
  </li>;
}
function SkillsGroup({ profile, label = 'Skills', onSelect }: { profile: PublicProfile; label?: string; onSelect?(skill: Skill): void }) {
  const sorted = [...profile.skills].sort(byLevel);
  return <section aria-labelledby={`skills-${profile.accountId}`}>
    <div className="bp-pf-label"><h2 id={`skills-${profile.accountId}`}>{label}</h2>
      <span className="bp-pf-label-end" title="Chance you'd solve this today. Drops if you don't practice.">Recall<Info size={13} aria-label="Recall: chance you'd solve this today. Drops if you don't practice." role="img" /></span></div>
    <div className="bp-v2-card bp-pf-group">{!sorted.length ? <p className="bp-pf-empty">Solve a challenge to start a skill. Every skill starts at Beginner 1.</p>
      : <ul>{sorted.map(skill => <SkillRow key={skill.concept} skill={skill} onSelect={onSelect} />)}</ul>}</div>
  </section>;
}
function FadingNudge({ profile }: { profile: PublicProfile }) {
  const due = profile.refresherDue.map(item => skillName(item.concept));
  if (!due.length) return null;
  return <div className="bp-pf-group bp-pf-nudge"><TrendingDown size={18} aria-hidden="true" />
    <div><p className="bp-pf-nudge-title">{due.length} {due.length === 1 ? 'skill' : 'skills'} fading: {due.join(', ')}</p>
      <p className="bp-pf-caption">You'll get a 1-question refresher on your next video</p></div></div>;
}
function WorthLearning({ profile }: { profile: PublicProfile }) {
  const items = profile.topInDemand.filter(item => safeVideo(item.videoUrl)).slice(0, 3);
  if (!items.length) return null;
  return <section aria-labelledby="worth-head"><SectionLabel><span id="worth-head">Worth learning next</span></SectionLabel>
    <ul className="bp-pf-group">{items.map(item => <li key={item.concept}><a className="bp-pf-linkrow" href={item.videoUrl} target="_blank" rel="noreferrer">
      <span className="bp-pf-linkrow-text"><span className="bp-pf-row-title">{skillName(item.concept)}</span><span className="bp-pf-sub">{item.reason}</span>
        {SOURCES[item.concept] && <span className="bp-pf-caption">{SOURCES[item.concept]}</span>}</span>
      <ExternalLink size={16} aria-hidden="true" className="bp-pf-trail" /><span className="sr-only">(opens a tutorial on YouTube)</span></a></li>)}</ul></section>;
}

// ---------- in demand: hiring fields from a dated job-posting snapshot (GET /v2/skills/fields) ----------
const fieldLevel = z.object({ level: z.string(), levelName: z.string(), rank: z.number(), concept: z.string() }).nullable();
const fieldsSchema = z.object({
  pulledAt: z.string().nullable(), method: z.string().nullable().optional(),
  sources: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })),
  fields: z.array(z.object({
    id: z.string(), name: z.string(), summary: z.string(), rising: z.boolean(), wefSkill: z.string().nullable().optional(),
    postings: z.object({ calgary: z.number(), alberta: z.number(), canada: z.number(), count: z.number(), where: z.string(),
      scope: z.string(), searchUrl: z.string(), titleContains: z.string() }),
    skills: z.array(z.object({ name: z.string(), share: z.number().nullable().optional(), tracked: z.boolean(), level: fieldLevel })),
    alsoAskedFor: z.array(z.object({ name: z.string(), share: z.number() })),
    tutorials: z.array(z.object({ url: z.string(), title: z.string(), channel: z.string().nullable().optional(), codingChallenges: z.number(),
      firstChallenge: z.object({ atS: z.number(), title: z.string() }) })),
  })),
});
type Fields = z.infer<typeof fieldsSchema>;
type Field = Fields['fields'][number];
const safeJobs = (url: string) => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'www.adzuna.ca'; } catch { return false; } };
const clock = (s: number) => { const t = Math.floor(s); return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const pct = (share: number) => `${Math.round(share * 100)}%`;
// Snapshot dates are calendar days (YYYY-MM-DD): read them at local noon so no timezone shifts the day.
const pullDate = (day: string) => shortDate(/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00` : day);

function useFields(accountId: string) {
  const [state, setState] = useState<Fields | 'error' | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    void get(`/v2/skills/fields?accountId=${encodeURIComponent(accountId)}`, controller.signal)
      .then(data => fieldsSchema.parse(data)).then(data => { if (!controller.signal.aborted) setState(data); })
      .catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [accountId]);
  return state;
}

function FieldRow({ field, pulledAt }: { field: Field; pulledAt: string | null }) {
  const p = field.postings;
  const local = p.scope === 'city' ? `${num(p.calgary)} open in Calgary` : p.scope === 'province' ? `${num(p.alberta)} open in Alberta` : `${num(p.canada)} open in Canada`;
  const tone = /energy/i.test(field.name) ? 'teal' : /cyber|security/i.test(field.name) ? 'blue' : 'violet';
  const Icon = tone === 'teal' ? BarChart3 : tone === 'blue' ? ShieldCheck : Layers3;
  return <li className="bp-pf-field" data-tone={tone}><details>
    <summary>
      <span className="bp-pf-field-icon" aria-hidden="true"><Icon size={20} strokeWidth={1.7} /></span>
      <span className="bp-pf-linkrow-text">
        <span className="bp-pf-row-title">{field.name}{field.rising && <span className="bp-pf-rising" title={field.wefSkill ? `WEF Future of Jobs 2025 fastest-growing skill: ${field.wefSkill}` : undefined}><TrendingUp size={14} aria-hidden="true" />Rising</span>}</span>
        <span className="bp-pf-sub">{local}{p.scope !== 'country' ? ` · ${num(p.canada)} across Canada` : ''}</span>
        <ul className="bp-pf-tags bp-pf-tags-sm">{field.skills.map(s => <li key={s.name}>{s.name}</li>)}</ul>
      </span>
      <ChevronDown size={16} aria-hidden="true" className="bp-pf-trail bp-pf-field-chevron" />
    </summary>
    <div className="bp-pf-field-body">
      <p className="bp-pf-sub">{field.summary}</p>
      <ul className="bp-pf-field-skills">{field.skills.map(s => <li key={s.name}>
        <span className="bp-pf-field-skill">{s.name}{typeof s.share === 'number' && <span className="bp-pf-caption">In {pct(s.share)} of postings</span>}</span>
        {s.level ? <Tier level={s.level.level} levelName={s.level.levelName} /> : <span className="bp-pf-caption">{s.tracked ? 'Not started' : 'Learn outside Breakpoint'}</span>}
      </li>)}</ul>
      {!!field.tutorials.length && <div className="bp-pf-field-block"><p className="bp-pf-caption">Practice it on real {field.name.toLowerCase()} work</p>
        <ul>{field.tutorials.filter(t => safeVideo(t.url)).map(t => <li key={t.url}><a className="bp-pf-field-link" href={t.url} target="_blank" rel="noreferrer">
          <span>{t.title}</span>
          <span className="bp-pf-caption">{t.codingChallenges} coding challenges · first at {clock(t.firstChallenge.atS)}: {t.firstChallenge.title}</span>
        </a></li>)}</ul></div>}
      {!!field.alsoAskedFor.length && <p className="bp-pf-sub">Also asked for: {field.alsoAskedFor.map(r => `${r.name} (${pct(r.share)})`).join(', ')}</p>}
      {safeJobs(p.searchUrl) && <a className="bp-pf-field-jobs" href={p.searchUrl} target="_blank" rel="noreferrer">
        See the {num(p.count)} postings in {p.where}<ExternalLink size={13} aria-hidden="true" /></a>}
      <p className="bp-pf-caption">Adzuna postings with “{p.titleContains}” in the title{pulledAt ? `, pulled ${pullDate(pulledAt)}` : ''}. Shares are across Canada.</p>
    </div>
  </details></li>;
}

/** Hiring fields first; the old hand-picked list is the fallback when the snapshot is missing or unreachable. */
function InDemand({ profile }: { profile: PublicProfile }) {
  const state = useFields(profile.accountId);
  if (state === null) return null;
  if (state === 'error' || !state.fields.length) return <WorthLearning profile={profile} />;
  return <section aria-labelledby="demand-head"><SectionLabel end={state.pulledAt ? <span className="bp-pf-label-end">{pullDate(state.pulledAt)}</span> : undefined}>
    <span id="demand-head">In demand</span></SectionLabel>
    <ul className="bp-v2-card bp-pf-group">{state.fields.map(field => <FieldRow key={field.id} field={field} pulledAt={state.pulledAt} />)}</ul>
    <p className="bp-pf-caption bp-pf-pad">Job counts: Adzuna Canada. Rising: WEF Future of Jobs 2025.</p>
  </section>;
}

// ---------- network ----------
type Kind = 'build' | 'teach' | 'learn';
type Pairing = { profile: PublicProfile; teach: Skill[]; give: Skill[]; shared: Skill[]; kind: Kind };
function strongWhereWeak(a: PublicProfile, b: PublicProfile) {
  const theirs = new Map(b.skills.map(skill => [skill.concept, rankOf(skill.level)]));
  return a.skills.filter(s => rankOf(s.level) >= STRONG && (theirs.get(s.concept) ?? 0) < STRONG).sort(byLevel);
}
function pair(me: PublicProfile, other: PublicProfile): Pairing | null {
  const teach = strongWhereWeak(other, me);
  const give = strongWhereWeak(me, other);
  const mine = new Map(me.skills.map(skill => [skill.concept, rankOf(skill.level)]));
  const shared = other.skills.filter(s => mine.has(s.concept) && rankOf(s.level) < STRONG && (mine.get(s.concept) ?? 0) < STRONG).sort(byLevel);
  if (teach.length && give.length) return { profile: other, teach, give, shared, kind: 'build' };
  if (teach.length) return { profile: other, teach, give, shared, kind: 'teach' };
  if (shared.length) return { profile: other, teach, give, shared, kind: 'learn' };
  return null;
}
function useNetwork(me: PublicProfile, accountIds: string[]) {
  const [others, setOthers] = useState<PublicProfile[]>([]);
  const key = accountIds.join(',');
  useEffect(() => {
    const controller = new AbortController();
    setOthers([]);
    void Promise.all(accountIds.filter(id => id !== me.accountId).map(id => get(`/v2/profile/${encodeURIComponent(id)}/public`, controller.signal)
      .then(data => profileSchema.safeParse(data)).then(parsed => (parsed.success ? parsed.data : null)).catch(() => null)))
      .then(list => { if (!controller.signal.aborted) setOthers(list.filter((item): item is PublicProfile => !!item && item.public)); });
    return () => controller.abort();
  }, [me.accountId, key]);
  return useMemo(() => others.map(other => pair(me, other)).filter((item): item is Pairing => !!item), [me, others]);
}
const SECTIONS: { kind: Kind; title: string }[] = [{ kind: 'build', title: 'Build partners' }, { kind: 'teach', title: 'Can teach you' }, { kind: 'learn', title: 'Learn together' }];
function subtitleFor(p: Pairing) {
  if (p.kind === 'build') return `Brings ${joinAnd(unique(p.teach.map(s => topicOf(s.concept))))} · You bring ${joinAnd(unique(p.give.map(s => topicOf(s.concept))))}`;
  if (p.kind === 'teach') return `${p.teach.slice(0, 2).map(s => skillName(s.concept)).join(', ')}${p.teach.length > 2 ? ` +${p.teach.length - 2}` : ''}`;
  return `Both learning ${joinAnd(p.shared.slice(0, 2).map(s => skillName(s.concept)))}`;
}
function NetworkTab({ pairings, toggle, onView }: { pairings: Pairing[]; toggle?: ReactNode; onView?(accountId: string): void }) {
  return <>
    {toggle && <div className="bp-pf-group">{toggle}</div>}
    {!pairings.length && <p className="bp-pf-empty">No matches yet. Matches appear as your skills grow.</p>}
    {SECTIONS.map(section => {
      const rows = pairings.filter(p => p.kind === section.kind);
      if (!rows.length) return null;
      return <section key={section.kind} aria-labelledby={`net-${section.kind}`}>
        <SectionLabel end={<span className="bp-pf-label-end">{rows.length}</span>}><span id={`net-${section.kind}`}>{section.title}</span></SectionLabel>
        <ul className="bp-v2-card bp-pf-group">{rows.map(p => {
          const inner = <><Avatar id={p.profile.accountId} name={p.profile.displayName} size={36} />
            <span className="bp-pf-person"><span className="bp-pf-row-title">{displayName(p.profile.displayName)}</span><span className="bp-pf-sub">{subtitleFor(p)}</span></span>
            {onView && <ChevronRight size={16} aria-hidden="true" className="bp-pf-trail" />}</>;
          return <li key={p.profile.accountId}>{onView
            ? <button type="button" className="bp-pf-personrow" onClick={() => onView(p.profile.accountId)} aria-label={`View ${displayName(p.profile.displayName)}'s profile`}>{inner}</button>
            : <div className="bp-pf-personrow">{inner}</div>}</li>;
        })}</ul></section>;
    })}
  </>;
}

// ---------- hero + tabs ----------
function Hero({ profile }: { profile: PublicProfile }) {
  const best = [...profile.skills].sort(byLevel)[0];
  const xp = profile.skills.reduce((sum, skill) => sum + skill.xp, 0);
  const solved = profile.skills.reduce((sum, skill) => sum + skill.passed, 0);
  return <header className="bp-pf-hero">
    <Avatar id={profile.accountId} name={profile.displayName} size={48} />
    <div className="bp-pf-hero-text">
      <h1>{displayName(profile.displayName)}</h1>
      {best ? <p className="bp-pf-sub"><Tier level={best.level} levelName={best.levelName} suffix={` in ${skillName(best.concept)}`} /></p> : <p className="bp-pf-sub">Just getting started</p>}
      <p className="bp-pf-stats"><span><b>{num(xp)}</b> XP</span><span>· <b>{num(solved)}</b> solved</span><span>· <b>{num(profile.skills.length)}</b> {profile.skills.length === 1 ? 'skill' : 'skills'}</span></p>
    </div>
  </header>;
}
type ProfileTab = 'home' | 'skills' | 'history' | 'network';
function Tabs({ tab, setTab, count }: { tab: ProfileTab; setTab(tab: ProfileTab): void; count: number }) {
  const tabs: { id: ProfileTab; label: string; count?: number }[] = [{ id: 'home', label: 'Home' }, { id: 'skills', label: 'Skills' }, { id: 'history', label: 'History' }, { id: 'network', label: 'Network', count }];
  const onKey = (event: ReactKeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const i = tabs.findIndex(t => t.id === tab);
    const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!.id;
    setTab(next); (event.currentTarget.querySelector(`#tab-${next}`) as HTMLElement | null)?.focus();
  };
  return <div className="bp-pf-tabs" role="tablist" aria-label="Profile sections" onKeyDown={onKey}>
    {tabs.map(item => <button key={item.id} type="button" role="tab" id={`tab-${item.id}`} aria-controls={`panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}>
      {item.label}{!!item.count && <span className="bp-pf-tab-count">{item.count}</span>}
      {tab === item.id && <motion.span layoutId="bp-pf-underline" className="bp-pf-underline" transition={{ duration: 0.15 }} />}
    </button>)}
  </div>;
}
export function ProfileView({ profile, accountIds, onViewProfile, toggle }: { profile: PublicProfile; accountIds?: string[]; onViewProfile?(accountId: string): void; toggle?: ReactNode }) {
  const [tab, setTab] = useState<ProfileTab>('home');
  const [skill, setSkill] = useState<Skill | null>(null);
  const [solution, setSolution] = useState<SavedSolution | null>(null);
  const [review, setReview] = useState<Skill | null>(null);
  const history = useHistory(profile.accountId);
  const ids = accountIds ?? profile.complements.map(mate => mate.accountId);
  const pairings = useNetwork(profile, ids);
  const due = profile.skills.find(s => profile.refresherDue.some(d => d.concept === s.concept));
  const back = () => { setSolution(null); setReview(null); };
  const focusView = useRef<HTMLDivElement>(null);
  useEffect(() => { focusView.current?.focus({ preventScroll: true }); }, [skill, solution, review, tab]);
  return <MotionConfig reducedMotion="user"><article className="bp-v2 bp-pf-root bp-pf-page bp-learning-home" aria-label="Skill profile">
    <div ref={focusView} tabIndex={-1} className="bp-learning-view">
    {solution ? <SolutionDetail row={solution} onBack={back} onDeleted={() => { setSolution(null); history.refresh(); }} />
    : review ? <SkillReview key={`${profile.accountId}/${review.concept}`} accountId={profile.accountId} concept={review.concept} level={review.level} onBack={back} />
    : skill ? <section className="bp-learning-detail" aria-label={`${skillName(skill.concept)} details`}>
      <button className="bp-pf-back" onClick={() => setSkill(null)}><ArrowLeft size={16} />Back</button>
      <h1>{skillName(skill.concept)}</h1><p className="bp-pf-caption">Your progress & recall</p>
      <ul className="bp-learning-skill-detail"><SkillRow skill={skill} /></ul>
      <button className="bp-pf-primary" onClick={() => setReview(skill)}>Review skill</button>
      <SectionLabel><span>Learned here</span></SectionLabel><HistoryList rows={history.rows.filter(r => r.concepts.includes(skill.concept))} onSelect={setSolution} />
    </section> : <>
      <div className="bp-learning-welcome"><p className="bp-pf-caption">YOUR LEARNING SPACE</p><Hero profile={profile} /></div>
      <Tabs tab={tab} setTab={setTab} count={pairings.length} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="bp-pf-panel">
        {tab === 'home' ? <>
          <InDemand profile={profile} />
          {due && <div className="bp-learning-nudge"><TrendingDown size={19} /><div><strong>Keep {skillName(due.concept)} fresh</strong><small>One quick question</small></div><button className="bp-pf-primary" onClick={() => setReview(due)}>Review now</button></div>}
          <SectionLabel end={<button className="bp-learning-link" onClick={() => setTab('history')}>View history<ChevronRight size={14} /></button>}><span>Recent practice</span></SectionLabel>
          <HistoryList rows={history.rows.slice(0, 2)} onSelect={setSolution} />
          <SkillsGroup profile={{ ...profile, skills: [...profile.skills].sort(byLevel).slice(0, 2) }} label="Your skills" onSelect={setSkill} />
          <button className="bp-learning-link" onClick={() => setTab('skills')}>See all {profile.skills.length} skills<ChevronRight size={14} /></button>
        </> : tab === 'skills' ? <SkillsGroup profile={profile} onSelect={setSkill} />
          : tab === 'history' ? <><SectionLabel><span>Learning history</span></SectionLabel><p className="bp-learning-privacy">Private to this browser and learner. Last 200 saved solutions. Export anything you want to keep.</p><HistoryList rows={history.rows} onSelect={setSolution} /></>
          : <NetworkTab pairings={pairings} toggle={toggle} onView={onViewProfile} />}
        {history.error && tab !== 'network' && <p className="bp-pf-caption" role="status">{history.error}</p>}
      </div>
    </>}
    </div>
  </article></MotionConfig>;
}

// ---------- teammate detail ----------
const contactSchema = z.object({ accountId: z.string(), linkedin: z.string().url().optional(), github: z.string().url().optional(), discord: z.string().optional() });
function introFor(kind: Kind, me: PublicProfile | null, them: PublicProfile, p: Pairing | null) {
  const hi = `Hi ${firstName(them.displayName)}, I'm ${me ? firstName(me.displayName) : 'a learner'}.`;
  if (p && kind === 'build') {
    const theirs = unique(p.teach.map(s => topicOf(s.concept))); const mine = unique(p.give.map(s => topicOf(s.concept)));
    return `${hi} You're strong in ${joinAnd(theirs)} and I'm strong in ${joinAnd(mine)}. Want to team up for a project or hackathon?`;
  }
  if (p && kind === 'learn') return `${hi} We're both learning ${joinAnd(p.shared.slice(0, 2).map(s => skillName(s.concept)))}. Want to practice together?`;
  const two = (p?.teach ?? []).slice(0, 2);
  const mine = new Map((me?.skills ?? []).map(skill => [skill.concept, skill.xp]));
  const started = two.length > 0 && two.every(s => (mine.get(s.concept) ?? 0) > 0);
  return `${hi}${two.length ? ` You're strong in ${joinAnd(two.map(s => skillName(s.concept)))}, which ${started ? "I'm working on" : 'I want to learn'}.` : ''} Open to pairing on a project or hackathon?`;
}
function Tags({ skills }: { skills: Skill[] }) {
  return <ul className="bp-pf-tags">{skills.map(s => <li key={s.concept}>{skillName(s.concept)}</li>)}</ul>;
}
function AutoTextarea({ value, onChange, id }: { value: string; onChange(value: string): void; id: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; }, [value]);
  return <textarea ref={ref} id={id} className="bp-pf-textarea" rows={4} value={value} onChange={event => onChange(event.target.value)} />;
}
function TeammateDetail({ accountId, me, onBack }: { accountId: string; me: PublicProfile | null; onBack(): void }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [contact, setContact] = useState<z.infer<typeof contactSchema> | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'intro' | 'discord' | null>(null);
  const [intro, setIntro] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null); setContact(null); setError('');
    void get(`/v2/profile/${encodeURIComponent(accountId)}/public`, controller.signal).then(data => {
      if (!controller.signal.aborted) setProfile(profileSchema.parse(data));
    }).catch(cause => { if (!controller.signal.aborted) setError(loadError(cause)); });
    void get(`/v2/profile/${encodeURIComponent(accountId)}/contacts`, controller.signal).then(data => {
      const parsed = contactSchema.safeParse(data); if (!controller.signal.aborted) setContact(parsed.success ? parsed.data : { accountId });
    }).catch(() => { if (!controller.signal.aborted) setContact({ accountId }); });
    return () => controller.abort();
  }, [accountId]);
  const p = profile && me ? pair(me, profile) : null;
  const kind: Kind = p?.kind ?? 'teach';
  useEffect(() => { if (profile) setIntro(introFor(kind, me, profile, p)); }, [profile?.accountId, me?.accountId, kind]);
  const flash = (what: 'intro' | 'discord', text: string) => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(what); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(null), 2000); })
      .catch(() => setError('Could not copy to the clipboard.'));
  };
  const name = profile ? firstName(profile.displayName) : '';
  const mineXp = new Map((me?.skills ?? []).map(skill => [skill.concept, skill.xp]));
  let match: ReactNode = null;
  if (profile && p) {
    if (p.kind === 'build') {
      const areas = unique([...p.teach, ...p.give].map(s => AREA[topicOf(s.concept)] ?? topicOf(s.concept)));
      match = <><p className="bp-pf-body">{areas.length > 1 ? `Together you cover ${joinAnd(areas)}.` : `Together you cover more of ${areas[0] ?? 'the stack'}.`}</p>
        <div className="bp-pf-columns"><div><h3>They bring</h3><Tags skills={p.teach} /></div><div><h3>You bring</h3><Tags skills={p.give} /></div></div></>;
    } else if (p.kind === 'teach') {
      const notStarted = p.teach.every(s => !(mineXp.get(s.concept) ?? 0));
      const allAdvanced = p.teach.every(s => tierOf(s.level) === 'advanced' || tierOf(s.level) === 'expert');
      match = <><p className="bp-pf-body">{name} is {allAdvanced ? 'advanced' : 'strong'} in {p.teach.length} {p.teach.length === 1 ? 'skill' : 'skills'} {notStarted ? "you haven't started" : "you're still learning"}.</p>
        <ul className="bp-pf-pairs">{p.teach.map(s => <li key={s.concept}><span>{skillName(s.concept)}</span><Tier level={s.level} levelName={s.levelName} /></li>)}</ul></>;
    } else {
      match = <><p className="bp-pf-body">You're both learning {p.shared.length} {p.shared.length === 1 ? 'skill' : 'skills'} at a similar level.</p>
        <ul className="bp-pf-pairs">{p.shared.map(s => <li key={s.concept}><span>{skillName(s.concept)}</span><Tier level={s.level} levelName={s.levelName} /></li>)}</ul></>;
    }
  }
  const hasContact = !!(contact && (contact.linkedin || contact.github || contact.discord));
  return <div className="bp-v2 bp-pf-root bp-pf-page">
    <button type="button" className="bp-pf-back" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />Back</button>
    {error && <p role="alert" className="bp-pf-body">{error}</p>}
    {!profile ? (!error && <Skeleton />) : <>
      <Hero profile={profile} />
      {match && <section aria-labelledby="match-head"><SectionLabel><span id="match-head">{SECTIONS.find(s => s.kind === kind)?.title ?? 'Why you match'}</span></SectionLabel>
        <div className="bp-v2-card bp-pf-group bp-pf-pad">{match}</div></section>}
      <section aria-labelledby="intro-head"><SectionLabel><label id="intro-head" htmlFor="bp-pf-intro">Intro message</label></SectionLabel>
        <AutoTextarea id="bp-pf-intro" value={intro} onChange={setIntro} />
        <button type="button" className="bp-pf-primary" onClick={() => flash('intro', intro)}>
          {copied === 'intro' ? <><Check size={18} aria-hidden="true" />Copied</> : <><Copy size={18} aria-hidden="true" />Copy intro</>}</button>
        {contact && (hasContact ? <div className="bp-pf-contacts">
          {contact.linkedin && <a className="bp-pf-ghost" href={contact.linkedin} target="_blank" rel="noreferrer">Open LinkedIn<ExternalLink size={14} aria-hidden="true" /></a>}
          {contact.github && <a className="bp-pf-ghost" href={contact.github} target="_blank" rel="noreferrer">Open GitHub<ExternalLink size={14} aria-hidden="true" /></a>}
          {contact.discord && <button type="button" className="bp-pf-ghost" onClick={() => flash('discord', contact.discord!)}>{copied === 'discord' ? <><Check size={14} aria-hidden="true" />Copied</> : <><Copy size={14} aria-hidden="true" />Copy Discord handle</>}</button>}
        </div> : <p className="bp-pf-caption bp-pf-center">{name} hasn't added contact links yet.</p>)}
        <p className="sr-only" aria-live="polite">{copied ? 'Copied to clipboard' : ''}</p>
      </section>
      <SkillsGroup profile={profile} label={`${name}'s skills`} />
    </>}
  </div>;
}
function Skeleton() {
  return <div className="bp-pf-stack" role="status" aria-label="Loading profile"><div className="bp-pf-skel" style={{ height: 72 }} /><div className="bp-pf-skel" /></div>;
}

// ---------- settings sheet ----------
const FREQUENCIES: { value: LearnerSettingsValue['frequency']; label: string }[] = [{ value: 'few', label: 'Fewer' }, { value: 'normal', label: 'Normal' }, { value: 'many', label: 'More' }];
function SettingsSheet({ settings, onChange, onClose, layout, onLayout }: { settings: LearnerSettingsValue; onChange(value: LearnerSettingsValue): void; onClose(): void; layout: PracticeLayout; onLayout(value: PracticeLayout): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key !== 'Tab' || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')].filter(el => !el.hasAttribute('disabled'));
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  return <motion.div className="bp-pf-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.div ref={ref} role="dialog" aria-modal="true" aria-labelledby="settings-title" className="bp-pf-sheet" onClick={event => event.stopPropagation()}
      initial={{ y: 32 }} animate={{ y: 0 }} exit={{ y: 32 }} transition={{ duration: 0.2 }}>
      <span className="bp-pf-handle" aria-hidden="true" />
      <div className="bp-pf-sheet-head"><h2 id="settings-title">Settings</h2><button type="button" className="bp-pf-iconbtn" aria-label="Close settings" onClick={onClose}><X size={20} /></button></div>
      <label className="bp-pf-setting"><span><span className="bp-pf-row-title">Pause for practice</span><span className="bp-pf-sub">Stop the video before the instructor solves a problem.</span></span>
        <input type="checkbox" role="switch" className="bp-pf-switch" checked={settings.autoPause} onChange={event => onChange({ ...settings, autoPause: event.target.checked })} /></label>
      <div className="bp-pf-setting is-stacked"><span><span className="bp-pf-row-title" id="freq-label">Pause frequency</span><span className="bp-pf-sub">How often Breakpoint stops the video.</span></span>
        <div className="bp-pf-segmented" role="radiogroup" aria-labelledby="freq-label">{FREQUENCIES.map(option =>
          <button key={option.value} type="button" role="radio" aria-checked={settings.frequency === option.value} onClick={() => onChange({ ...settings, frequency: option.value })}>{option.label}</button>)}</div></div>
      <div className="bp-pf-setting is-stacked"><span><span className="bp-pf-row-title" id="layout-label">Practice placement</span><span className="bp-pf-sub">Your workspace, beside or below the video.</span></span>
        <div className="bp-pf-segmented" role="group" aria-labelledby="layout-label">
          <button type="button" aria-pressed={layout === 'side'} onClick={() => onLayout('side')}>Side panel</button>
          <button type="button" aria-pressed={layout === 'below'} onClick={() => onLayout('below')}>Below video</button>
        </div><p className="bp-pf-caption">Side placement adapts below on smaller windows. Your draft stays with you.</p></div>
      {!!settings.disabledVideos.length && <details className="bp-pf-paused-videos"><summary>Paused videos ({settings.disabledVideos.length})</summary>
        <p className="bp-pf-sub">Automatic practice is off for these videos.</p>
        {settings.disabledVideos.map(id => <div key={id}><span>{id}</span><button type="button" onClick={() => onChange({ ...settings, disabledVideos: settings.disabledVideos.filter(video => video !== id) })}>Enable practice</button></div>)}
      </details>}
    </motion.div>
  </motion.div>;
}

// ---------- page ----------
export function ProfilePage({ preferences: prefs = preferences }: { preferences?: Preferences } = {}) {
  const [accounts, setAccounts] = useState<LocalAccount[]>([]);
  const [account, setAccount] = useState('');
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState('');
  const [savingError, setSavingError] = useState('');
  const [retry, setRetry] = useState(0);
  const [settings, setSettings] = useState<LearnerSettingsValue>(defaultSettings);
  const [storageReady, setStorageReady] = useState(false);
  const [layout, setLayout] = useState<PracticeLayout>('below');
  useEffect(() => { let active = true; void prefs.loadPracticeLayout?.().then(value => { if (active) setLayout(value); }).catch(() => {}); return () => { active = false; }; }, [prefs]);
  const saveLayout = (value: PracticeLayout) => {
    void persist(() => prefs.savePracticeLayout?.(value) ?? Promise.resolve()).then(() => { setLayout(value); setSavingError(''); }).catch(() => setSavingError('Placement could not be saved.'));
  };
  const [viewing, setViewing] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const closeSettings = useCallback(() => setSheet(false), []);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setProfile(null); setAccount('');
    const saved = Promise.all([prefs.loadActiveAccount(), prefs.loadLearnerSettings()]).then(([accountId, settings]) => {
      if (!controller.signal.aborted) { setSettings(settings); setStorageReady(true); }
      return accountId;
    });
    void Promise.all([get('/v2/accounts', controller.signal), saved]).then(([data, stored]) => {
      if (controller.signal.aborted) return;
      const parsed = z.union([z.array(accountSchema), z.object({ accounts: z.array(accountSchema) }).transform(value => value.accounts)]).parse(data);
      setAccounts(parsed);
      setAccount(parsed.some(item => item.accountId === stored) ? stored : parsed[0]?.accountId ?? '');
      if (!parsed.length) setError('No local test accounts are available yet.');
    }).catch(cause => { if (!controller.signal.aborted) setError(loadError(cause)); });
    return () => controller.abort();
  }, [retry, prefs]);
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    setError('');
    void get(`/v2/profile/${encodeURIComponent(account)}`, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      const parsed = profileSchema.parse(data);
      if (parsed.accountId !== account) throw new Error('The profile did not match the selected account.');
      setProfile(parsed);
    }).catch(cause => { if (!controller.signal.aborted) setError(loadError(cause)); });
    return () => controller.abort();
  }, [account, reload]);
  const saveSettings = (value: LearnerSettingsValue) => {
    setSettings(value); setSavingError('');
    void persist(() => prefs.saveLearnerSettings(value)).catch(() => setSavingError('Practice settings could not be saved.'));
  };
  const toggle = profile && <label className="bp-pf-setting"><span><span className="bp-pf-row-title">Visible in Network</span>
    <span className="bp-pf-sub">Others can find and match with you</span></span>
    <input type="checkbox" role="switch" className="bp-pf-switch" checked={profile.public} disabled={busy} onChange={event => {
      const next = event.target.checked; setBusy(true); setSavingError('');
      void fetch(`${base}/v2/profile/${encodeURIComponent(profile.accountId)}/public`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: next }) })
        .then(response => { if (!response.ok) throw new Error(); setReload(value => value + 1); })
        .catch(() => setSavingError('Visibility could not be saved.')).finally(() => setBusy(false));
    }} /></label>;
  const current = accounts.find(item => item.accountId === account);
  return <MotionConfig reducedMotion="user"><main className="bp-v2 bp-v2-profile bp-pf-root">
    <header className="bp-pf-top">
      <span className="bp-pf-brand"><BrandMark size={24} />Breakpoint</span>
      <span className="bp-pf-top-actions">
        {DEMO_MODE && !!accounts.length && <label className="bp-pf-viewing"><span className="sr-only">Viewing as</span>
          <span aria-hidden="true">Viewing as {current ? displayName(current.displayName) : ''}</span><ChevronDown size={14} aria-hidden="true" />
          <select value={account} onChange={event => {
            const accountId = event.target.value;
            setProfile(null); setViewing(null); setAccount(accountId); setSavingError('');
            void persist(() => prefs.setActiveAccount(accountId)).catch(() => setSavingError('Account selection could not be saved.'));
          }}>{accounts.map(item => <option key={item.accountId} value={item.accountId}>{displayName(item.displayName)}</option>)}</select></label>}
        <button type="button" className="bp-pf-iconbtn" aria-label="Settings" aria-haspopup="dialog" onClick={() => setSheet(true)} disabled={!storageReady}><Settings2 size={20} /></button>
      </span>
    </header>
    {viewing ? <TeammateDetail accountId={viewing} me={profile} onBack={() => setViewing(null)} />
      : error ? <div role="alert" className="bp-pf-page"><p className="bp-pf-body">{error}</p><button type="button" className="bp-pf-ghost" onClick={() => setRetry(value => value + 1)}>Retry</button></div>
      : profile ? <ProfileView key={profile.accountId} profile={profile} accountIds={accounts.map(item => item.accountId)} onViewProfile={setViewing} toggle={toggle} />
      : <div className="bp-pf-page"><Skeleton /></div>}
    {savingError && <p role="alert" className="bp-pf-body bp-pf-gutter">{savingError}</p>}
    <AnimatePresence>{sheet && <SettingsSheet layout={layout} onLayout={saveLayout} settings={settings} onChange={saveSettings} onClose={closeSettings} />}</AnimatePresence>
  </main></MotionConfig>;
}
