import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { ArrowLeft, Check, ChevronRight, Copy, ExternalLink, Settings2, TriangleAlert, X } from 'lucide-react';
import '@fontsource-variable/inter';
import type { PublicProfile } from '../v2/types';
import levels from '../../../contracts/v2/levels.json';
import { conceptName, defaultSettings, LearnerSettings, type LearnerSettingsValue } from '../ui/v2';
import { z } from 'zod';

const accountSchema = z.object({ accountId: z.string().min(1), displayName: z.string(), public: z.boolean().optional() });
const profileSchema = z.object({
  schemaVersion: z.literal(2), accountId: z.string(), displayName: z.string(), public: z.boolean(),
  skills: z.array(z.object({ concept: z.string(), level: z.string(), levelName: z.string(), xp: z.number().nonnegative(), strength: z.number().min(0).max(1), lastPracticedAt: z.string(), passed: z.number().nonnegative(), tutorials: z.number().nonnegative() })),
  highlights: z.array(z.string()), refresherDue: z.array(z.object({ concept: z.string(), reason: z.string() })),
  topInDemand: z.array(z.object({ concept: z.string(), reason: z.string(), videoUrl: z.string() })),
  complements: z.array(z.object({ accountId: z.string(), displayName: z.string(), why: z.string() })),
});
export type LocalAccount = { accountId: string; displayName: string; public?: boolean };
type Preferences = Pick<typeof import('../plan/preferences'), 'loadLearnerSettings' | 'saveLearnerSettings' | 'loadActiveAccount' | 'setActiveAccount'>;
const preferences: Preferences = {
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

// ---------- presentation helpers ----------
/** Demo presentation: shows the account switcher ("Viewing as") and hides the "(test)" suffix. */
const DEMO_MODE = import.meta.env.WXT_DEMO_MODE !== 'false';
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const num = (value: number) => nf.format(Math.round(value));
const displayName = (name: string) => (DEMO_MODE ? name.replace(/\s*\(test\)\s*$/i, '') : name);
const firstName = (name: string) => displayName(name).split(' ')[0] ?? name;
const SHORT: Record<string, string> = {
  'sql-joins': 'SQL joins', 'sql-select': 'SQL queries', 'react-components': 'React components', 'react-state': 'React state',
  'js-dom': 'DOM & events', 'js-async': 'Async JavaScript', 'http-apis': 'HTTP & APIs', 'dynamic-programming': 'Dynamic programming',
  'stacks-queues': 'Stacks & queues', 'two-pointers': 'Two pointers', 'linked-lists': 'Linked lists', 'lists': 'Lists', 'dicts': 'Dictionaries',
};
const shortName = (concept: string) => SHORT[concept] ?? conceptName(concept);
const joinAnd = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
/** Where each in-demand reason comes from (backend/content/skills/in-demand.json sourceIds). */
const DEMAND_SOURCE: Record<string, string> = {
  'react-state': 'Stack Overflow Survey 2025 · GitHub Octoverse 2025', 'http-apis': 'Stack Overflow Developer Survey 2025',
  'sql-joins': 'Stack Overflow Developer Survey 2025', 'js-async': 'GitHub Octoverse 2025', 'git': 'GitHub Octoverse 2025',
};
type Skill = PublicProfile['skills'][number];
const rankOf = (level: string) => Math.max(0, levels.levels.findIndex(item => item.id === level));
const STRONG = 5; // Intermediate I and up
const tierOf = (level: string) => (levels.levels.find(item => item.id === level) as { tier?: string } | undefined)?.tier ?? level.split('-')[0] ?? 'beginner';
const byLevel = (a: Skill, b: Skill) => rankOf(b.level) - rankOf(a.level) || b.xp - a.xp;
function progressFor(skill: Skill) {
  const index = rankOf(skill.level);
  const current = levels.levels[index]; const next = levels.levels[index + 1];
  const progress = current && next ? Math.max(0, Math.min(1, (skill.xp - current.minXp) / (next.minXp - current.minXp))) : 1;
  return { next, progress };
}
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const initials = (name: string) => displayName(name).trim().split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';

function Avatar({ name, size }: { name: string; size: 40 | 56 }) {
  return <span className={`bp-pf-avatar is-${size}`} aria-hidden="true">{initials(name)}</span>;
}
function TierBadge({ skill }: { skill: Pick<Skill, 'level' | 'levelName'> }) {
  return <span className={`bp-pf-tier is-${tierOf(skill.level)}`}><span className="bp-pf-tier-dot" aria-hidden="true" />{skill.levelName}</span>;
}
function Recall({ strength }: { strength: number }) {
  const pct = Math.round(strength * 100);
  if (strength < 0.5) return <span className="bp-pf-recall is-fading"><TriangleAlert size={13} aria-hidden="true" />Fading</span>;
  return <span className={`bp-pf-recall${strength >= 0.8 ? ' is-strong' : ''}`}><span className="bp-pf-recall-dot" aria-hidden="true" />Recall {pct}%</span>;
}

// ---------- skills ----------
function SkillRow({ skill }: { skill: Skill }) {
  const { next, progress } = progressFor(skill);
  const name = conceptName(skill.concept);
  const pct = Math.round(progress * 100);
  const xpLine = <><span className="bp-pf-nw">{num(skill.xp)} XP</span> · <span className="bp-pf-nw">{next ? `${num(Math.max(0, next.minXp - skill.xp))} XP to ${next.name}` : 'Max level'}</span></>;
  const activity = skill.passed > 0 ? `${num(skill.passed)} solved` : `Watched ${skill.tutorials} ${skill.tutorials === 1 ? 'tutorial' : 'tutorials'}`;
  return <li className="bp-pf-skill">
    <div className="bp-pf-skill-line"><h3>{name}</h3><TierBadge skill={skill} /></div>
    <div className="bp-pf-bar" role="progressbar" aria-label={`${name} level progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
      aria-valuetext={next ? `${pct}% of the way to ${next.name}` : 'Max level'}><span style={{ width: `${Math.max(pct, 2)}%` }} /></div>
    <div className="bp-pf-skill-line is-meta"><span className="bp-pf-meta">{xpLine}</span><Recall strength={skill.strength} /></div>
    <p className="bp-pf-sub">{activity} · Last practiced {shortDate(skill.lastPracticedAt)}</p>
  </li>;
}
function SkillsCard({ profile, title = 'Skills' }: { profile: PublicProfile; title?: string }) {
  const sorted = [...profile.skills].sort(byLevel);
  return <section className="bp-v2-card bp-pf-card" aria-labelledby={`skills-${profile.accountId}`}>
    <header className="bp-pf-card-head"><h2 id={`skills-${profile.accountId}`}>{title}</h2><small>{sorted.length} tracked</small></header>
    {!sorted.length ? <p className="bp-pf-sub">Solve a challenge to start a skill. Every concept starts at Beginner I.</p>
      : <ul className="bp-pf-list">{sorted.map(skill => <SkillRow key={skill.concept} skill={skill} />)}</ul>}
  </section>;
}
function RefreshCard({ profile }: { profile: PublicProfile }) {
  if (!profile.refresherDue.length) return null;
  return <section className="bp-pf-card bp-pf-refresh" aria-labelledby="refresh-head">
    <header className="bp-pf-card-head"><h2 id="refresh-head"><TriangleAlert size={15} aria-hidden="true" />Time to refresh</h2></header>
    <p className="bp-pf-body">{joinAnd(profile.refresherDue.map(item => conceptName(item.concept)))} {profile.refresherDue.length === 1 ? 'is' : 'are'} fading. You'll get a one-question refresher on your next video.</p>
  </section>;
}
function DemandCard({ profile }: { profile: PublicProfile }) {
  const items = profile.topInDemand.slice(0, 3);
  if (!items.length) return null;
  return <section className="bp-pf-card" aria-labelledby="demand-head">
    <header className="bp-pf-card-head"><h2 id="demand-head">In demand</h2></header>
    <ul className="bp-pf-list">{items.map(item => <li key={item.concept} className="bp-pf-demand">
      <div><h3>{conceptName(item.concept)}</h3><p className="bp-pf-body">{item.reason}</p>{DEMAND_SOURCE[item.concept] && <small className="bp-pf-source">{DEMAND_SOURCE[item.concept]}</small>}</div>
      {safeVideo(item.videoUrl) && <a className="bp-pf-btn is-outline is-small" href={item.videoUrl} target="_blank" rel="noreferrer" aria-label={`Find a tutorial on ${conceptName(item.concept)}`}>Find tutorial<ExternalLink size={13} aria-hidden="true" /></a>}
    </li>)}</ul>
  </section>;
}

// ---------- teammates ----------
type Pairing = { profile: PublicProfile; teach: Skill[]; give: Skill[]; shared: Skill[]; kind: 'build' | 'teach' | 'learn' };
function strongWhereWeak(a: PublicProfile, b: PublicProfile) {
  const theirs = new Map(b.skills.map(skill => [skill.concept, rankOf(skill.level)]));
  return a.skills.filter(s => rankOf(s.level) >= STRONG && (theirs.get(s.concept) ?? 0) < STRONG).sort(byLevel);
}
function pair(me: PublicProfile, other: PublicProfile): Pairing | null {
  const teach = strongWhereWeak(other, me);
  const give = strongWhereWeak(me, other);
  const mine = new Map(me.skills.map(skill => [skill.concept, rankOf(skill.level)]));
  const shared = other.skills.filter(s => mine.has(s.concept) && Math.abs((mine.get(s.concept) ?? 0) - rankOf(s.level)) <= 2).sort(byLevel);
  if (teach.length && give.length) return { profile: other, teach, give, shared, kind: 'build' };
  if (teach.length) return { profile: other, teach, give, shared, kind: 'teach' };
  if (shared.length) return { profile: other, teach, give, shared, kind: 'learn' };
  return null;
}
function useTeammates(me: PublicProfile, accountIds: string[]) {
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
const SECTIONS: { kind: Pairing['kind']; title: string }[] = [
  { kind: 'teach', title: 'Can teach you' }, { kind: 'learn', title: 'Learn together' }, { kind: 'build', title: 'Build partners' },
];
function reasonFor(p: Pairing) {
  const n = (count: number) => `${count} ${count === 1 ? 'skill' : 'skills'}`;
  if (p.kind === 'build') return `Teaches you ${n(p.teach.length)}, learns ${n(p.give.length)} from you`;
  if (p.kind === 'teach') return `Can teach you ${n(p.teach.length)}`;
  return `Learning ${n(p.shared.length)} at your level`;
}
function TeammatesCard({ pairings, onView }: { pairings: Pairing[]; onView?(accountId: string): void }) {
  if (!pairings.length) return <section className="bp-v2-card bp-pf-card"><header className="bp-pf-card-head"><h2>Teammates</h2></header>
    <p className="bp-pf-sub">No matches yet. Matches appear as your skills grow.</p></section>;
  return <section className="bp-v2-card bp-pf-card" aria-label="Teammates">
    {SECTIONS.map(section => {
      const rows = pairings.filter(p => p.kind === section.kind);
      if (!rows.length) return null;
      return <div key={section.kind} className="bp-pf-group">
        <header className="bp-pf-card-head"><h2>{section.title}</h2><small>{rows.length}</small></header>
        <ul className="bp-pf-list">{rows.map(p => {
          const skills = p.kind === 'learn' ? p.shared : p.teach;
          const content = <>
            <Avatar name={p.profile.displayName} size={40} />
            <span className="bp-pf-mate-text"><span className="bp-pf-mate-name">{displayName(p.profile.displayName)}</span>
              <span className="bp-pf-meta">{reasonFor(p)}</span>
              <span className="bp-pf-chips">{skills.map(s => <span key={s.concept} className="bp-pf-chip">{shortName(s.concept)}</span>)}</span></span>
            {onView && <ChevronRight size={18} className="bp-pf-chevron" aria-hidden="true" />}</>;
          return <li key={p.profile.accountId}>{onView
            ? <button type="button" className="bp-pf-mate" onClick={() => onView(p.profile.accountId)} aria-label={`View ${displayName(p.profile.displayName)}'s profile`}>{content}</button>
            : <div className="bp-pf-mate">{content}</div>}</li>;
        })}</ul>
      </div>;
    })}
  </section>;
}

// ---------- my profile ----------
function HeaderCard({ profile, toggle }: { profile: PublicProfile; toggle?: React.ReactNode }) {
  const best = [...profile.skills].sort(byLevel)[0];
  const xp = profile.skills.reduce((sum, skill) => sum + skill.xp, 0);
  const solved = profile.skills.reduce((sum, skill) => sum + skill.passed, 0);
  return <section className="bp-pf-card bp-pf-head">
    <div className="bp-pf-id"><Avatar name={profile.displayName} size={56} />
      <div><h1>{displayName(profile.displayName)}</h1>
        {best ? <p className="bp-pf-level"><TierBadge skill={best} /><span>in {shortName(best.concept)}</span></p> : <p className="bp-pf-sub">Just getting started</p>}</div>
    </div>
    <dl className="bp-pf-stats">
      <div><dt>Total XP</dt><dd>{num(xp)}</dd></div>
      <div><dt>Solved</dt><dd>{num(solved)}</dd></div>
      <div><dt>Skills</dt><dd>{num(profile.skills.length)}</dd></div>
    </dl>
    {toggle}
  </section>;
}
export function ProfileView({ profile, accountIds, onViewProfile, toggle }: { profile: PublicProfile; accountIds?: string[]; onViewProfile?(accountId: string): void; toggle?: React.ReactNode }) {
  const [tab, setTab] = useState<'skills' | 'teammates'>('skills');
  const ids = accountIds ?? profile.complements.map(mate => mate.accountId);
  const pairings = useTeammates(profile, ids);
  return <MotionConfig reducedMotion="user"><article className="bp-v2 bp-pf bp-pf-root" aria-label="Skill profile">
    <HeaderCard profile={profile} toggle={toggle} />
    <div className="bp-pf-tabs" role="tablist" aria-label="Profile sections">
      <button type="button" role="tab" id="tab-skills" aria-controls="panel-skills" aria-selected={tab === 'skills'} onClick={() => setTab('skills')}>Skills</button>
      <button type="button" role="tab" id="tab-teammates" aria-controls="panel-teammates" aria-selected={tab === 'teammates'} onClick={() => setTab('teammates')}>Teammates
        {!!pairings.length && <span className="bp-pf-count">{pairings.length}</span>}</button>
    </div>
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={tab} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="bp-pf-stack"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
        {tab === 'skills' ? <><SkillsCard profile={profile} /><RefreshCard profile={profile} /><DemandCard profile={profile} /></>
          : <TeammatesCard pairings={pairings} onView={onViewProfile} />}
      </motion.div>
    </AnimatePresence>
  </article></MotionConfig>;
}

// ---------- teammate detail ----------
function introFor(me: PublicProfile | null, them: PublicProfile, teach: Skill[]) {
  const two = teach.slice(0, 2);
  const mine = new Map((me?.skills ?? []).map(skill => [skill.concept, skill.xp]));
  const started = two.length > 0 && two.every(s => (mine.get(s.concept) ?? 0) > 0);
  return `Hi ${firstName(them.displayName)}! I'm ${me ? firstName(me.displayName) : 'a learner'} on Breakpoint.`
    + (two.length ? ` You're strong in ${joinAnd(two.map(s => shortName(s.concept)))}, which ${started ? "I'm working on" : 'I want to learn'}.` : '')
    + ' Want to pair up on a project or hackathon?';
}
function TeammateProfile({ accountId, me, onBack }: { accountId: string; me: PublicProfile | null; onBack(): void }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [intro, setIntro] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null); setError('');
    void get(`/v2/profile/${encodeURIComponent(accountId)}/public`, controller.signal).then(data => {
      if (!controller.signal.aborted) setProfile(profileSchema.parse(data));
    }).catch(cause => { if (!controller.signal.aborted) setError(loadError(cause)); });
    return () => controller.abort();
  }, [accountId]);
  const teach = profile && me ? strongWhereWeak(profile, me) : [];
  const give = profile && me ? strongWhereWeak(me, profile) : [];
  const mineXp = new Map((me?.skills ?? []).map(skill => [skill.concept, skill.xp]));
  const both = profile && me ? profile.skills.filter(s => (mineXp.get(s.concept) ?? 0) > 0 && rankOf(s.level) < STRONG) : [];
  useEffect(() => { if (profile) setIntro(introFor(me, profile, teach)); }, [profile?.accountId, me?.accountId]);
  const started = teach.filter(s => (mineXp.get(s.concept) ?? 0) > 0);
  const status = !started.length ? (teach.length === 1 ? " You haven't started it yet." : " You haven't started any of these yet.")
    : started.length === teach.length ? ` You're a beginner in ${teach.length === 1 ? 'it' : 'all of them'}.`
    : ` You're a beginner in ${joinAnd(started.map(s => shortName(s.concept)))} and haven't started the rest.`;
  const copy = () => {
    void navigator.clipboard.writeText(intro).then(() => {
      setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => setError('Could not copy to the clipboard.'));
  };
  return <div className="bp-v2 bp-pf bp-pf-root">
    <button type="button" className="bp-pf-back" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Back</button>
    {error ? <p role="alert" className="bp-pf-body">{error}</p> : !profile ? <Skeleton /> : <>
      <HeaderCard profile={profile} />
      <section className="bp-pf-card" aria-labelledby="match-head">
        <header className="bp-pf-card-head"><h2 id="match-head">Why you match</h2></header>
        {teach.length ? <>
          <p className="bp-pf-body">{firstName(profile.displayName)} is strong in {joinAnd(teach.map(s => shortName(s.concept)))}.{status}</p>
          <p className="bp-pf-label">Can teach you</p>
          <ul className="bp-pf-chips">{teach.map(s => <li key={s.concept} className="bp-pf-chip">{shortName(s.concept)}</li>)}</ul>
        </> : <p className="bp-pf-body">You're at a similar level, so you can learn together.</p>}
        {!!give.length && <><p className="bp-pf-label">You can teach them</p>
          <ul className="bp-pf-chips">{give.map(s => <li key={s.concept} className="bp-pf-chip">{shortName(s.concept)}</li>)}</ul></>}
        {!give.length && !!both.length && <p className="bp-pf-body is-secondary">You're both learning: {joinAnd(both.map(s => shortName(s.concept)))}</p>}
        <div className="bp-pf-divider" />
        <label className="bp-pf-label" htmlFor="bp-pf-intro">Intro message</label>
        <textarea id="bp-pf-intro" className="bp-pf-intro" rows={4} value={intro} onChange={event => setIntro(event.target.value)} />
        <button type="button" className="bp-pf-btn is-primary is-block" onClick={copy}>
          {copied ? <><Check size={16} aria-hidden="true" />Copied</> : <><Copy size={16} aria-hidden="true" />Copy intro</>}
        </button>
        <p className="bp-pf-caption" aria-live="polite">{copied ? 'Paste it in a LinkedIn or Discord message' : ' '}</p>
      </section>
      <SkillsCard profile={profile} title={`${firstName(profile.displayName)}'s skills`} />
    </>}
  </div>;
}
function Skeleton() {
  return <div className="bp-pf-stack" role="status" aria-label="Loading profile"><div className="bp-pf-skel" style={{ height: 180 }} /><div className="bp-pf-skel" /></div>;
}

// ---------- settings sheet ----------
function SettingsSheet({ settings, onChange, onClose }: { settings: LearnerSettingsValue; onChange(value: LearnerSettingsValue): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="bp-pf-scrim" onClick={onClose}>
    <motion.div ref={ref} role="dialog" aria-modal="true" aria-label="Settings" className="bp-pf-sheet" onClick={event => event.stopPropagation()}
      initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.2 }}>
      <header className="bp-pf-card-head"><h2>Settings</h2><button type="button" className="bp-pf-icon" aria-label="Close settings" onClick={onClose}><X size={18} /></button></header>
      <LearnerSettings value={settings} onChange={onChange} />
    </motion.div>
  </div>;
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
  const [viewing, setViewing] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
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
  const toggle = profile && <label className="bp-pf-toggle"><span><span className="bp-pf-toggle-title">Visible to teammates</span>
    <span className="bp-pf-sub">{profile.public ? 'Others can find and match with you' : 'Hidden from matches'}</span></span>
    <input type="checkbox" role="switch" checked={profile.public} disabled={busy} onChange={event => {
      const next = event.target.checked; setBusy(true); setSavingError('');
      void fetch(`${base}/v2/profile/${encodeURIComponent(profile.accountId)}/public`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: next }) })
        .then(response => { if (!response.ok) throw new Error(); setReload(value => value + 1); })
        .catch(() => setSavingError('Visibility could not be saved.')).finally(() => setBusy(false));
    }} /></label>;
  return <MotionConfig reducedMotion="user"><main className="bp-v2 bp-v2-profile bp-pf-root">
    <header className="bp-pf-top">
      <span className="bp-pf-brand">Breakpoint</span>
      <span className="bp-pf-top-actions">
        {DEMO_MODE && !!accounts.length && <label className="bp-pf-viewing"><span>Viewing as</span><select value={account} onChange={event => {
          const accountId = event.target.value;
          setProfile(null); setViewing(null); setAccount(accountId); setSavingError('');
          void persist(() => prefs.setActiveAccount(accountId)).catch(() => setSavingError('Account selection could not be saved.'));
        }}>{accounts.map(item => <option key={item.accountId} value={item.accountId}>{displayName(item.displayName)}</option>)}</select></label>}
        <button type="button" className="bp-pf-icon" aria-label="Settings" aria-haspopup="dialog" onClick={() => setSheet(true)} disabled={!storageReady}><Settings2 size={18} /></button>
      </span>
    </header>
    {viewing ? <TeammateProfile accountId={viewing} me={profile} onBack={() => setViewing(null)} />
      : error ? <div role="alert" className="bp-pf bp-pf-stack"><p className="bp-pf-body">{error}</p><button type="button" className="bp-pf-btn is-outline" onClick={() => setRetry(value => value + 1)}>Retry</button></div>
      : profile ? <ProfileView profile={profile} accountIds={accounts.map(item => item.accountId)} onViewProfile={setViewing} toggle={toggle} />
      : <div className="bp-pf"><Skeleton /></div>}
    {savingError && <p role="alert" className="bp-pf-body bp-pf-pad">{savingError}</p>}
    <AnimatePresence>{sheet && <SettingsSheet settings={settings} onChange={saveSettings} onClose={() => setSheet(false)} />}</AnimatePresence>
  </main></MotionConfig>;
}
