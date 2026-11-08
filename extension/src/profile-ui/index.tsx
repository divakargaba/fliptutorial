import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { animate, AnimatePresence, motion, MotionConfig } from 'motion/react';
import { ArrowLeft, ChartColumn, Check, ChevronRight, CircleCheck, Copy, ExternalLink, GraduationCap, Handshake, Layers, Lightbulb, RotateCcw, Sparkles, TrendingDown, TrendingUp, TriangleAlert, Users, Zap } from 'lucide-react';
import '@fontsource-variable/inter';
import type { PublicProfile } from '../v2/types';
import levels from '../../../contracts/v2/levels.json';
import { conceptName, defaultSettings, LearnerSettings, type LearnerSettingsValue } from '../ui/v2';
import { z } from 'zod';

const accountSchema = z.object({ accountId: z.string().min(1), displayName: z.string() });
const profileSchema = z.object({
  schemaVersion: z.literal(2), accountId: z.string(), displayName: z.string(), public: z.boolean(),
  skills: z.array(z.object({ concept: z.string(), level: z.string(), levelName: z.string(), xp: z.number().nonnegative(), strength: z.number().min(0).max(1), lastPracticedAt: z.string(), passed: z.number().nonnegative(), tutorials: z.number().nonnegative() })),
  highlights: z.array(z.string()), refresherDue: z.array(z.object({ concept: z.string(), reason: z.string() })),
  topInDemand: z.array(z.object({ concept: z.string(), reason: z.string(), videoUrl: z.string() })),
  complements: z.array(z.object({ accountId: z.string(), displayName: z.string(), why: z.string() })),
});
export type LocalAccount = { accountId: string; displayName: string };
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
type Skill = PublicProfile['skills'][number];
type Mate = PublicProfile['complements'][number];
const rankOf = (level: string) => Math.max(0, levels.levels.findIndex(item => item.id === level));
const STRONG = 5; // index of Intermediate I
const ease = [0.22, 1, 0.36, 1] as const;
const firstName = (name: string) => name.split(' ')[0] ?? name;
function initials(name: string) {
  return name.replace(/\(.*?\)/g, '').trim().split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
}
function hueOf(name: string) { let hue = 0; for (const char of name) hue = (hue * 31 + char.charCodeAt(0)) % 360; return hue; }
function progressFor(skill: Skill) {
  const index = rankOf(skill.level);
  const current = levels.levels[index]; const next = levels.levels[index + 1];
  const progress = current && next ? Math.max(0, Math.min(1, (skill.xp - current.minXp) / (next.minXp - current.minXp))) : 1;
  return { next, progress };
}
const byLevel = (a: Skill, b: Skill) => rankOf(b.level) - rankOf(a.level) || b.xp - a.xp;
function Avatar({ name, size = 40, ring }: { name: string; size?: number; ring?: number }) {
  const hue = hueOf(name);
  const r = size / 2 + 4; const c = 2 * Math.PI * r;
  return <span className="bp-pf-avatar-wrap" style={{ width: size + 12, height: size + 12 }} aria-hidden="true">
    {ring !== undefined && <svg width={size + 12} height={size + 12} className="bp-pf-ring">
      <circle cx={size / 2 + 6} cy={size / 2 + 6} r={r} className="bp-pf-ring-track" />
      <motion.circle cx={size / 2 + 6} cy={size / 2 + 6} r={r} className="bp-pf-ring-fill" strokeDasharray={c}
        initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - ring) }} transition={{ duration: 1.1, ease }} />
    </svg>}
    <span className="bp-pf-avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${hue} 70% 58%), hsl(${(hue + 40) % 360} 65% 42%))` }}>{initials(name)}</span>
  </span>;
}
function Count({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => { const controls = animate(0, value, { duration: 0.9, ease, onUpdate: v => setShown(Math.round(v)) }); return () => controls.stop(); }, [value]);
  return <>{shown.toLocaleString()}</>;
}
function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return <div className="bp-pf-stat"><dt><span className="bp-pf-stat-icon">{icon}</span>{label}</dt><dd><Count value={value} /></dd></div>;
}
function Hero({ profile, extra }: { profile: PublicProfile; extra?: ReactNode }) {
  const xp = profile.skills.reduce((sum, skill) => sum + skill.xp, 0);
  const solved = profile.skills.reduce((sum, skill) => sum + skill.passed, 0);
  const best = [...profile.skills].sort(byLevel)[0];
  return <motion.section className="bp-pf-hero" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }}>
    <div className="bp-pf-hero-top">
      <Avatar name={profile.displayName} size={52} ring={best ? progressFor(best).progress : 0} />
      <div className="bp-pf-hero-text"><h1>{profile.displayName}</h1>
        {best ? <p><span className={`bp-pf-pill${rankOf(best.level) >= STRONG ? ' is-strong' : ''}`}>{best.levelName}</span><span>in {conceptName(best.concept)}</span></p> : <p>Just getting started</p>}
      </div>
    </div>
    <dl className="bp-pf-stats">
      <Stat icon={<Zap size={14} />} label="Total XP" value={xp} />
      <Stat icon={<CircleCheck size={14} />} label="Solved" value={solved} />
      <Stat icon={<Layers size={14} />} label="Skills" value={profile.skills.length} />
    </dl>
    {extra}
  </motion.section>;
}
function SkillRow({ skill, index }: { skill: Skill; index: number }) {
  const { next, progress } = progressFor(skill);
  const name = conceptName(skill.concept);
  const fading = skill.strength < 0.35;
  return <motion.li className="bp-pf-skill" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.05 * index, ease }}>
    <div className="bp-pf-skill-top"><h3>{name}</h3><span className={`bp-pf-pill${rankOf(skill.level) >= STRONG ? ' is-strong' : ''}`}>{skill.levelName}</span></div>
    <div className="bp-pf-bar" aria-hidden="true"><motion.span initial={{ width: 0 }} animate={{ width: `${Math.max(progress * 100, 2)}%` }} transition={{ duration: 0.9, delay: 0.1 + 0.05 * index, ease }} /></div>
    <progress className="sr-only" aria-label={`${name} level progress`} value={progress} max={1} />
    <div className="bp-pf-skill-meta">
      <small><span className="bp-pf-num">{skill.xp}</span> XP{next ? <> · <span className="bp-pf-num">{next.minXp - skill.xp}</span> to {next.name}</> : ' · Max level'}</small>
      {fading ? <small className="bp-pf-fading"><TrendingDown size={12} /> Fading</small>
        : <small className="bp-pf-strength" title="Strength fades without practice"><span style={{ opacity: 0.35 + skill.strength * 0.65 }} />{Math.round(skill.strength * 100)}%</small>}
    </div>
    <small className="bp-pf-sub">{skill.passed} solved · {skill.tutorials} {skill.tutorials === 1 ? 'tutorial' : 'tutorials'} · {new Date(skill.lastPracticedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>
  </motion.li>;
}
function SkillsCard({ profile }: { profile: PublicProfile }) {
  return <section className="bp-v2-card bp-pf-card"><header className="bp-pf-card-head"><h2>Skills</h2><small>Ranked by level</small></header>
    {!profile.skills.length ? <small>Complete a challenge to start building your skills. Every concept starts at Beginner I.</small>
      : <ul className="bp-pf-list">{[...profile.skills].sort(byLevel).map((skill, index) => <SkillRow key={skill.concept} skill={skill} index={index} />)}</ul>}
  </section>;
}
function GrowthCards({ profile }: { profile: PublicProfile }) {
  return <>
    {!!profile.refresherDue.length && <section className="bp-pf-card bp-pf-refresh"><header className="bp-pf-card-head"><h2><RotateCcw size={14} /> Time to refresh</h2></header>
      <small>These are fading. A one-question refresher brings them back next time you watch.</small>
      <ul className="bp-pf-chips">{profile.refresherDue.map(item => <li key={item.concept} className="bp-pf-chip is-warn">{conceptName(item.concept)}</li>)}</ul></section>}
    {!!profile.topInDemand.length && <section className="bp-pf-card"><header className="bp-pf-card-head"><h2><TrendingUp size={14} /> In demand</h2><small>Top 3 right now</small></header>
      <ul className="bp-pf-list">{profile.topInDemand.slice(0, 3).map(item => <li key={item.concept} className="bp-pf-demand">
        <div><h3>{conceptName(item.concept)}</h3><small>{item.reason}</small></div>
        {safeVideo(item.videoUrl) && <a href={item.videoUrl} target="_blank" rel="noreferrer" aria-label={`Watch a tutorial on ${conceptName(item.concept)}`}>Watch <ExternalLink size={12} /></a>}
      </li>)}</ul></section>}
  </>;
}
function strongIn(profile: PublicProfile | undefined, against: PublicProfile | null) {
  if (!profile) return [];
  const theirs = new Map((against?.skills ?? []).map(skill => [skill.concept, rankOf(skill.level)]));
  return profile.skills.filter(s => rankOf(s.level) >= STRONG && (theirs.get(s.concept) ?? 0) < STRONG).sort(byLevel);
}
function MateCard({ mate, me, detail, index, onView }: { mate: Mate; me: PublicProfile; detail?: PublicProfile; index: number; onView?(): void }) {
  const [lead = mate.why] = mate.why.split('. ');
  const teaches = strongIn(detail, me).slice(0, 2);
  const Tag = onView ? motion.button : motion.div;
  return <li><Tag type={onView ? 'button' : undefined} className="bp-pf-mate" onClick={onView} aria-label={onView ? `View ${mate.displayName}'s profile` : undefined}
    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.06 * index, ease }} whileHover={onView ? { y: -1 } : undefined} whileTap={onView ? { scale: 0.99 } : undefined}>
    <Avatar name={mate.displayName} size={38} />
    <span className="bp-pf-mate-text"><strong>{mate.displayName}</strong><span>{lead.replace(/\.$/, '')}</span>
      {!!teaches.length && <span className="bp-pf-chips">{teaches.map(s => <span key={s.concept} className="bp-pf-chip is-good"><GraduationCap size={11} />{conceptName(s.concept)}</span>)}</span>}
    </span>
    {onView && <ChevronRight size={16} className="bp-pf-chevron" />}
  </Tag></li>;
}
function TeammatesCard({ profile, onViewProfile }: { profile: PublicProfile; onViewProfile?(accountId: string): void }) {
  const [details, setDetails] = useState<Record<string, PublicProfile>>({});
  useEffect(() => {
    const controller = new AbortController();
    for (const mate of profile.complements) void get(`/v2/profile/${encodeURIComponent(mate.accountId)}/public`, controller.signal)
      .then(data => { const parsed = profileSchema.safeParse(data); if (parsed.success && !controller.signal.aborted) setDetails(prev => ({ ...prev, [mate.accountId]: parsed.data })); }).catch(() => {});
    return () => controller.abort();
  }, [profile.accountId, profile.complements]);
  return <section className="bp-v2-card bp-pf-card"><header className="bp-pf-card-head"><h2><Users size={14} /> Complementary teammates</h2></header>
    <small className="bp-pf-sub">Strong where you're still learning, and keen to learn what you know. Pair up for projects and hackathons.</small>
    {!profile.complements.length ? <p className="bp-pf-empty">No matches yet. Keep practicing and matches will appear as your skills grow.</p>
      : <ul className="bp-pf-mates">{profile.complements.map((mate, index) => <MateCard key={mate.accountId} mate={mate} me={profile} detail={details[mate.accountId]} index={index} onView={onViewProfile ? () => onViewProfile(mate.accountId) : undefined} />)}</ul>}
  </section>;
}
export function ProfileView({ profile, onViewProfile, heroExtra }: { profile: PublicProfile; onViewProfile?(accountId: string): void; heroExtra?: ReactNode }) {
  const [tab, setTab] = useState<'skills' | 'teammates'>('skills');
  const tabs = [
    { id: 'skills' as const, label: 'Skills', icon: <ChartColumn size={14} /> },
    { id: 'teammates' as const, label: 'Teammates', icon: <Users size={14} />, count: profile.complements.length },
  ];
  return <MotionConfig reducedMotion="user"><article className="bp-v2 bp-pf bp-pf-root" aria-label="Skill profile">
    <Hero profile={profile} extra={heroExtra} />
    {!!profile.highlights.length && <ul className="bp-pf-highlights" aria-label="Highlights">{profile.highlights.slice(0, 2).map(item => <li key={item}><Sparkles size={12} />{item}</li>)}</ul>}
    <div className="bp-pf-tabs" role="tablist" aria-label="Profile sections">
      {tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
        {tab === item.id && <motion.span layoutId={`bp-pf-tab-${profile.accountId}`} className="bp-pf-tab-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
        <span className="bp-pf-tab-label">{item.icon}{item.label}{!!item.count && <em>{item.count}</em>}</span>
      </button>)}
    </div>
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease }}>
        {tab === 'skills' ? <><SkillsCard profile={profile} /><GrowthCards profile={profile} /></> : <TeammatesCard profile={profile} onViewProfile={onViewProfile} />}
      </motion.div>
    </AnimatePresence>
  </article></MotionConfig>;
}
function TeammateProfile({ accountId, me, why, onBack }: { accountId: string; me: PublicProfile | null; why: string; onBack(): void }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null); setError('');
    void get(`/v2/profile/${encodeURIComponent(accountId)}/public`, controller.signal).then(data => {
      if (!controller.signal.aborted) setProfile(profileSchema.parse(data));
    }).catch(cause => { if (!controller.signal.aborted) setError(loadError(cause)); });
    return () => controller.abort();
  }, [accountId]);
  const theyTeach = strongIn(profile ?? undefined, me).slice(0, 3);
  const youTeach = strongIn(me ?? undefined, profile).slice(0, 3);
  const message = useMemo(() => {
    if (!profile) return '';
    const learn = theyTeach.map(s => conceptName(s.concept)); const give = youTeach.map(s => conceptName(s.concept));
    return `Hi ${firstName(profile.displayName)}! I'm ${me?.displayName ?? 'a learner'} on Breakpoint.`
      + (learn.length ? ` You're strong in ${learn.join(', ')}, which I'm working on.` : '')
      + (give.length ? ` I can help with ${give.join(', ')} in return.` : '')
      + ' Want to pair up on a project or hackathon and learn from each other?';
  }, [profile, me, theyTeach, youTeach]);
  const connect = () => {
    if (!message) return;
    void navigator.clipboard.writeText(message).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }).catch(() => setError('Could not copy to the clipboard.'));
  };
  return <MotionConfig reducedMotion="user"><div className="bp-v2 bp-pf bp-pf-root">
    <button type="button" className="bp-pf-back" onClick={onBack} aria-label="Back to your profile"><ArrowLeft size={14} /> Back</button>
    {error ? <div role="alert" className="bp-pf-card bp-pf-error"><TriangleAlert size={16} /><p>{error}</p></div> : !profile ? <Skeleton /> : <>
      <Hero profile={profile} />
      <motion.section className="bp-pf-card bp-pf-match" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.08, ease }}>
        <header className="bp-pf-card-head"><h2><Handshake size={15} /> Why you match</h2></header>
        <small className="bp-pf-sub">{why}</small>
        <div className="bp-pf-swap">
          <div><h3><GraduationCap size={13} /> They teach you</h3>{theyTeach.length ? <ul className="bp-pf-chips">{theyTeach.map(s => <li key={s.concept} className="bp-pf-chip is-good">{conceptName(s.concept)}</li>)}</ul> : <small>Nothing yet</small>}</div>
          <div><h3><Lightbulb size={13} /> You teach them</h3>{youTeach.length ? <ul className="bp-pf-chips">{youTeach.map(s => <li key={s.concept} className="bp-pf-chip is-accent">{conceptName(s.concept)}</li>)}</ul> : <small>Nothing yet</small>}</div>
        </div>
        <blockquote className="bp-pf-quote">{message}</blockquote>
        <motion.button type="button" className="bp-pf-connect" onClick={connect} whileTap={{ scale: 0.98 }}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={copied ? 'done' : 'idle'} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>
              {copied ? <><Check size={15} /> Intro copied, paste it in a DM</> : <><Copy size={15} /> Connect with {firstName(profile.displayName)}</>}
            </motion.span>
          </AnimatePresence>
        </motion.button>
      </motion.section>
      <SkillsCard profile={profile} />
    </>}
  </div></MotionConfig>;
}
function Skeleton() {
  return <div className="bp-pf" role="status" aria-label="Loading profile"><div className="bp-pf-skel bp-pf-skel-hero" /><div className="bp-pf-skel" /><div className="bp-pf-skel" /></div>;
}
function PublicToggle({ profile, onChange }: { profile: PublicProfile; onChange(next: boolean): void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <label className="bp-pf-public"><span><strong>{profile.public ? 'Visible to teammates' : 'Hidden from teammates'}</strong><small>{profile.public ? 'Others can find and match with you' : 'You won’t appear in anyone’s matches'}</small></span>
    <input type="checkbox" role="switch" className="bp-pf-switch" checked={profile.public} disabled={busy} onChange={event => {
      const next = event.target.checked; setBusy(true); setFailed(false);
      void fetch(`${base}/v2/profile/${encodeURIComponent(profile.accountId)}/public`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: next }) })
        .then(response => { if (!response.ok) throw new Error(); onChange(next); }).catch(() => setFailed(true)).finally(() => setBusy(false));
    }} />{failed && <small role="alert">Could not save.</small>}</label>;
}
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
  const [reload, setReload] = useState(0);
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
  const header = <header className="bp-pf-top">
    <span className="bp-pf-brand"><span className="bp-pf-logo"><Zap size={13} strokeWidth={2.5} /></span>Breakpoint</span>
    {!!accounts.length && <label className="bp-pf-account"><span className="sr-only">Test account</span><select value={account} onChange={event => {
      const accountId = event.target.value;
      setProfile(null); setViewing(null); setAccount(accountId); setSavingError('');
      void persist(() => prefs.setActiveAccount(accountId)).catch(() => setSavingError('Account selection could not be saved.'));
    }}>{accounts.map(item => <option key={item.accountId} value={item.accountId}>{item.displayName}</option>)}</select></label>}
  </header>;
  if (viewing) {
    const why = profile?.complements.find(person => person.accountId === viewing)?.why ?? '';
    return <main className="bp-v2 bp-v2-profile bp-pf-root">{header}<TeammateProfile accountId={viewing} me={profile} why={why} onBack={() => setViewing(null)} /></main>;
  }
  return <main className="bp-v2 bp-v2-profile bp-pf-root">{header}
    {error ? <div role="alert" className="bp-pf bp-pf-error-wrap"><div className="bp-pf-card bp-pf-error"><TriangleAlert size={16} /><p>{error}</p></div><button onClick={() => setRetry(value => value + 1)}>Retry</button></div>
      : profile ? <ProfileView profile={profile} onViewProfile={setViewing} heroExtra={<PublicToggle profile={profile} onChange={() => setReload(value => value + 1)} />} />
      : <Skeleton />}
    {storageReady && <div className="bp-pf-settings"><LearnerSettings value={settings} onChange={value => {
      setSettings(value); setSavingError('');
      void persist(() => prefs.saveLearnerSettings(value)).catch(() => setSavingError('Practice settings could not be saved.'));
    }} /></div>}{savingError && <p role="alert">{savingError}</p>}
  </main>;
}
