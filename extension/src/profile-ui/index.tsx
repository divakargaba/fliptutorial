import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Copy, Settings2 } from 'lucide-react';
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
const firstName = (name: string) => name.replace(/\s*\(.*?\)\s*/g, ' ').trim().split(' ')[0] ?? name;
const lower = (text: string) => text.toLowerCase();
function initials(name: string) {
  return name.replace(/\(.*?\)/g, '').trim().split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
}
function progressFor(skill: Skill) {
  const index = rankOf(skill.level);
  const current = levels.levels[index]; const next = levels.levels[index + 1];
  const progress = current && next ? Math.max(0, Math.min(1, (skill.xp - current.minXp) / (next.minXp - current.minXp))) : 1;
  return { next, progress };
}
const byLevel = (a: Skill, b: Skill) => rankOf(b.level) - rankOf(a.level) || b.xp - a.xp;
function strongIn(profile: PublicProfile | null | undefined, against: PublicProfile | null | undefined) {
  if (!profile) return [];
  const theirs = new Map((against?.skills ?? []).map(skill => [skill.concept, rankOf(skill.level)]));
  return profile.skills.filter(s => rankOf(s.level) >= STRONG && (theirs.get(s.concept) ?? 0) < STRONG).sort(byLevel);
}
const enter = { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.28, ease } };

function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return <span className="bp-pf-avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>{initials(name)}</span>;
}
function Identity({ profile }: { profile: PublicProfile }) {
  const xp = profile.skills.reduce((sum, skill) => sum + skill.xp, 0);
  const solved = profile.skills.reduce((sum, skill) => sum + skill.passed, 0);
  const best = [...profile.skills].sort(byLevel)[0];
  return <motion.header className="bp-pf-identity" {...enter}>
    <h1>{profile.displayName}</h1>
    <p className="bp-pf-mono">{best ? <>{lower(best.levelName)} · {lower(conceptName(best.concept))}</> : 'new learner'}<span className="bp-pf-sep">/</span>{xp.toLocaleString()} xp<span className="bp-pf-sep">/</span>{solved} solved</p>
  </motion.header>;
}
function Section({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return <section className="bp-v2-card bp-pf-panel">
    <div className="bp-pf-panel-head"><h2>{title}</h2>{meta && <small className="bp-pf-mono">{meta}</small>}</div>
    {children}
  </section>;
}
function SkillRow({ skill }: { skill: Skill }) {
  const { next, progress } = progressFor(skill);
  const name = conceptName(skill.concept);
  const fading = skill.strength < 0.35;
  return <li className="bp-pf-row">
    <div className="bp-pf-row-main">
      <span className="bp-pf-row-title">{fading && <span className="bp-pf-dot" title="Fading: practice soon" aria-label="Fading" />}{name}</span>
      <span className="bp-pf-row-sub bp-pf-mono">{skill.xp}{next ? ` / ${next.minXp}` : ''} xp</span>
    </div>
    <span className={`bp-pf-row-end bp-pf-mono${rankOf(skill.level) >= STRONG ? ' is-strong' : ''}`}>{lower(skill.levelName)}</span>
    <span className="bp-pf-track" aria-hidden="true"><motion.span initial={{ scaleX: 0 }} animate={{ scaleX: Math.max(progress, 0.02) }} transition={{ duration: 0.7, ease }} /></span>
    <progress className="sr-only" aria-label={`${name} level progress`} value={progress} max={1} />
  </li>;
}
function MateRow({ mate, detail, me, onView }: { mate: Mate; detail?: PublicProfile; me: PublicProfile; onView?(): void }) {
  const teaches = strongIn(detail, me).map(s => lower(conceptName(s.concept)));
  const sub = teaches.length ? `teaches ${teaches[0]}${teaches.length > 1 ? ` +${teaches.length - 1}` : ''}` : 'loading…';
  const inner = <><Avatar name={mate.displayName} />
    <span className="bp-pf-row-main"><span className="bp-pf-row-title">{firstName(mate.displayName)}</span><span className="bp-pf-row-sub bp-pf-mono">{sub}</span></span>
    {onView && <ChevronRight size={14} className="bp-pf-row-end" aria-hidden="true" />}</>;
  return <li>{onView ? <button type="button" className="bp-pf-row is-link" onClick={onView} aria-label={`View ${mate.displayName}'s profile`}>{inner}</button> : <div className="bp-pf-row">{inner}</div>}</li>;
}
function useMateDetails(profile: PublicProfile) {
  const [details, setDetails] = useState<Record<string, PublicProfile>>({});
  useEffect(() => {
    const controller = new AbortController();
    for (const mate of profile.complements) void get(`/v2/profile/${encodeURIComponent(mate.accountId)}/public`, controller.signal)
      .then(data => { const parsed = profileSchema.safeParse(data); if (parsed.success && !controller.signal.aborted) setDetails(prev => ({ ...prev, [mate.accountId]: parsed.data })); }).catch(() => {});
    return () => controller.abort();
  }, [profile.accountId, profile.complements]);
  return details;
}
function SkillsSection({ profile, limit, title = 'Skills' }: { profile: PublicProfile; limit?: number; title?: string }) {
  const sorted = [...profile.skills].sort(byLevel);
  return <Section title={title} meta={`${profile.skills.length} tracked`}>
    {!sorted.length ? <small className="bp-pf-empty">Solve a challenge to start a skill. Everything starts at beginner i.</small>
      : <ul className="bp-pf-rows">{sorted.slice(0, limit).map(skill => <SkillRow key={skill.concept} skill={skill} />)}</ul>}
  </Section>;
}
function UpNext({ profile }: { profile: PublicProfile }) {
  const refresh = profile.refresherDue.slice(0, 1);
  const trending = profile.topInDemand.filter(item => safeVideo(item.videoUrl)).slice(0, 2);
  if (!refresh.length && !trending.length) return null;
  return <Section title="Up next">
    <ul className="bp-pf-rows">
      {refresh.map(item => <li key={item.concept} className="bp-pf-row"><span className="bp-pf-row-main"><span className="bp-pf-row-title">Refresh {conceptName(item.concept)}</span><span className="bp-pf-row-sub bp-pf-mono">fading · quick question next video</span></span><span className="bp-pf-row-end bp-pf-mono is-warn">due</span></li>)}
      {trending.map(item => <li key={item.concept}><a className="bp-pf-row is-link" href={item.videoUrl} target="_blank" rel="noreferrer" aria-label={`Watch a tutorial on ${conceptName(item.concept)}`}>
        <span className="bp-pf-row-main"><span className="bp-pf-row-title">{conceptName(item.concept)}</span><span className="bp-pf-row-sub bp-pf-mono">in demand · watch a tutorial</span></span><ArrowUpRight size={14} className="bp-pf-row-end" aria-hidden="true" /></a></li>)}
    </ul>
  </Section>;
}
export function ProfileView({ profile, onViewProfile }: { profile: PublicProfile; onViewProfile?(accountId: string): void }) {
  const details = useMateDetails(profile);
  return <MotionConfig reducedMotion="user"><article className="bp-v2 bp-pf bp-pf-root" aria-label="Skill profile">
    <Identity profile={profile} />
    <SkillsSection profile={profile} limit={4} />
    <Section title="Teammates" meta={profile.complements.length ? `${profile.complements.length} matches` : undefined}>
      {!profile.complements.length ? <small className="bp-pf-empty">Matches show up as your skills grow.</small>
        : <ul className="bp-pf-rows">{profile.complements.map(mate => <MateRow key={mate.accountId} mate={mate} detail={details[mate.accountId]} me={profile} onView={onViewProfile ? () => onViewProfile(mate.accountId) : undefined} />)}</ul>}
    </Section>
    <UpNext profile={profile} />
  </article></MotionConfig>;
}
function TeammateProfile({ accountId, me, onBack }: { accountId: string; me: PublicProfile | null; onBack(): void }) {
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
  const theyTeach = strongIn(profile, me).slice(0, 2);
  const youTeach = strongIn(me, profile).slice(0, 2);
  const message = useMemo(() => {
    if (!profile) return '';
    const learn = theyTeach.map(s => conceptName(s.concept)); const give = youTeach.map(s => conceptName(s.concept));
    return `Hi ${firstName(profile.displayName)}! I'm ${me ? firstName(me.displayName) : 'a learner'} on Breakpoint.`
      + (learn.length ? ` I'm learning ${learn.join(' and ')}, which you're strong in.` : '')
      + (give.length ? ` I can help with ${give.join(' and ')}.` : '')
      + ' Want to pair up on a project or hackathon?';
  }, [profile, me, theyTeach, youTeach]);
  const connect = () => {
    if (!message) return;
    void navigator.clipboard.writeText(message).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2200); }).catch(() => setError('Could not copy to the clipboard.'));
  };
  return <div className="bp-v2 bp-pf bp-pf-root">
    <button type="button" className="bp-pf-back" onClick={onBack} aria-label="Back to your profile"><ArrowLeft size={14} /> Back</button>
    {error ? <p role="alert" className="bp-pf-error">{error}</p> : !profile ? <Skeleton /> : <>
      <Identity profile={profile} />
      <motion.section className="bp-pf-panel bp-pf-match" {...enter}>
        <ul className="bp-pf-checks">
          {theyTeach.map(s => <li key={s.concept}><Check size={13} /><span>Teaches you <strong>{conceptName(s.concept)}</strong></span></li>)}
          {youTeach.map(s => <li key={s.concept}><Check size={13} /><span>You teach them <strong>{conceptName(s.concept)}</strong></span></li>)}
          {!theyTeach.length && !youTeach.length && <li><Check size={13} /><span>Similar level, a good study partner</span></li>}
        </ul>
        <motion.button type="button" className="bp-pf-cta" onClick={connect} whileTap={{ scale: 0.98 }}>
          {copied ? <><Check size={14} /> Intro copied</> : <><Copy size={14} /> Connect with {firstName(profile.displayName)}</>}
        </motion.button>
        <small className="bp-pf-note">Copies a short intro you can send them.</small>
      </motion.section>
      <SkillsSection profile={profile} title={`${firstName(profile.displayName)}'s skills`} />
    </>}
  </div>;
}
function Skeleton() {
  return <div className="bp-pf" role="status" aria-label="Loading profile"><div className="bp-pf-skel" style={{ height: 56 }} /><div className="bp-pf-skel" /><div className="bp-pf-skel" /></div>;
}
function SettingsView({ profile, settings, onSettings, onPublic, onBack }: { profile: PublicProfile | null; settings: LearnerSettingsValue; onSettings(value: LearnerSettingsValue): void; onPublic(): void; onBack(): void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="bp-v2 bp-pf bp-pf-root">
    <button type="button" className="bp-pf-back" onClick={onBack} aria-label="Back to your profile"><ArrowLeft size={14} /> Back</button>
    <header className="bp-pf-identity"><h1 className="bp-pf-h1-sm">Settings</h1></header>
    {profile && <section className="bp-pf-panel"><label className="bp-pf-setting"><span><span className="bp-pf-row-title">Visible to teammates</span><span className="bp-pf-row-sub bp-pf-mono">{profile.public ? 'others can match with you' : 'hidden from matches'}</span></span>
      <input type="checkbox" role="switch" className="bp-pf-switch" checked={profile.public} disabled={busy} onChange={event => {
        const next = event.target.checked; setBusy(true); setFailed(false);
        void fetch(`${base}/v2/profile/${encodeURIComponent(profile.accountId)}/public`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: next }) })
          .then(response => { if (!response.ok) throw new Error(); onPublic(); }).catch(() => setFailed(true)).finally(() => setBusy(false));
      }} /></label>{failed && <small role="alert" className="bp-pf-error">Could not save.</small>}</section>}
    <div className="bp-pf-settings"><LearnerSettings value={settings} onChange={onSettings} /></div>
  </div>;
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
  const [view, setView] = useState<'home' | 'settings' | { mate: string }>('home');
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
  const saveSettings = (value: LearnerSettingsValue) => {
    setSettings(value); setSavingError('');
    void persist(() => prefs.saveLearnerSettings(value)).catch(() => setSavingError('Practice settings could not be saved.'));
  };
  const key = typeof view === 'string' ? view : `mate-${view.mate}`;
  return <MotionConfig reducedMotion="user"><main className="bp-v2 bp-v2-profile bp-pf-root">
    <header className="bp-pf-top">
      <span className="bp-pf-brand"><strong>Break</strong>point</span>
      <span className="bp-pf-top-actions">
        {!!accounts.length && <label className="bp-pf-account"><span className="sr-only">Test account</span><select value={account} onChange={event => {
          const accountId = event.target.value;
          setProfile(null); setView('home'); setAccount(accountId); setSavingError('');
          void persist(() => prefs.setActiveAccount(accountId)).catch(() => setSavingError('Account selection could not be saved.'));
        }}>{accounts.map(item => <option key={item.accountId} value={item.accountId}>{item.displayName}</option>)}</select></label>}
        <button type="button" className="bp-pf-icon" aria-label="Settings" aria-pressed={view === 'settings'} onClick={() => setView(view === 'settings' ? 'home' : 'settings')}><Settings2 size={15} /></button>
      </span>
    </header>
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={key} initial={{ opacity: 0, x: key === 'home' ? -8 : 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease }}>
        {view === 'settings' ? storageReady && <SettingsView profile={profile} settings={settings} onSettings={saveSettings} onPublic={() => setReload(value => value + 1)} onBack={() => setView('home')} />
          : typeof view === 'object' ? <TeammateProfile accountId={view.mate} me={profile} onBack={() => setView('home')} />
          : error ? <div role="alert" className="bp-pf bp-pf-error-wrap"><p className="bp-pf-error">{error}</p><button type="button" className="bp-pf-ghost" onClick={() => setRetry(value => value + 1)}>Retry</button></div>
          : profile ? <ProfileView profile={profile} onViewProfile={mate => setView({ mate })} />
          : <Skeleton />}
      </motion.div>
    </AnimatePresence>
    {savingError && <p role="alert" className="bp-pf-error">{savingError}</p>}
  </main></MotionConfig>;
}
