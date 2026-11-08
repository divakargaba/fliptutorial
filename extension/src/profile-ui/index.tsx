import { useEffect, useState, type ReactNode } from 'react';
import type { PublicProfile } from '../v2/types';
import levels from '../../../contracts/v2/levels.json';
import { conceptName, defaultSettings, LearnerSettings, type LearnerSettingsValue } from '../ui/v2';
import { z } from 'zod';
import './profile.css';

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
const rankOf = (level: string) => Math.max(0, levels.levels.findIndex(item => item.id === level));
const STRONG = 5; // index of Intermediate I
function initials(name: string) {
  return name.replace(/\(.*?\)/g, '').trim().split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
}
function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  let hue = 0; for (const char of name) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return <span className="bp-pf-avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${hue} 55% 42%)` }}>{initials(name)}</span>;
}
function progressFor(skill: Skill) {
  const index = rankOf(skill.level);
  const current = levels.levels[index]; const next = levels.levels[index + 1];
  const progress = current && next ? Math.max(0, Math.min(1, (skill.xp - current.minXp) / (next.minXp - current.minXp))) : 1;
  return { next, progress };
}
function topSkills(profile: PublicProfile, count = 3) {
  return [...profile.skills].sort((a, b) => rankOf(b.level) - rankOf(a.level) || b.xp - a.xp).slice(0, count);
}
function SkillRow({ skill }: { skill: Skill }) {
  const { next, progress } = progressFor(skill);
  const name = conceptName(skill.concept);
  const fading = skill.strength < 0.35;
  return <li className="bp-pf-skill">
    <div className="bp-pf-skill-top"><h3>{name}</h3><span className={`bp-pf-level${rankOf(skill.level) >= STRONG ? ' is-strong' : ''}`}>{skill.levelName}</span></div>
    <progress aria-label={`${name} level progress`} value={progress} max={1} />
    <div className="bp-pf-skill-meta">
      <small>{skill.xp} XP{next ? ` · ${next.minXp - skill.xp} to ${next.name}` : ' · Max level'}</small>
      <small className={fading ? 'is-fading' : ''} title="Strength fades without practice">{fading ? 'Fading' : 'Strength'} {Math.round(skill.strength * 100)}%</small>
    </div>
    <small>{skill.passed} solved · {skill.tutorials} {skill.tutorials === 1 ? 'tutorial' : 'tutorials'} · last {new Date(skill.lastPracticedAt).toLocaleDateString()}</small>
  </li>;
}
function Hero({ profile, extra }: { profile: PublicProfile; extra?: ReactNode }) {
  const xp = profile.skills.reduce((sum, skill) => sum + skill.xp, 0);
  const solved = profile.skills.reduce((sum, skill) => sum + skill.passed, 0);
  const best = topSkills(profile, 1)[0];
  return <section className="bp-pf-hero">
    <Avatar name={profile.displayName} size={52} />
    <div className="bp-pf-hero-text"><h1>{profile.displayName}</h1>
      <p>{best ? <>Top skill: <strong>{conceptName(best.concept)}</strong> · {best.levelName}</> : 'Just getting started'}</p></div>
    <dl className="bp-pf-stats">
      <div><dt>Total XP</dt><dd>{xp}</dd></div>
      <div><dt>Solved</dt><dd>{solved}</dd></div>
      <div><dt>Skills</dt><dd>{profile.skills.length}</dd></div>
    </dl>
    {extra}
  </section>;
}
function SkillsSection({ profile }: { profile: PublicProfile }) {
  return <section className="bp-v2-card bp-pf-card"><h2>Skills</h2>
    {!profile.skills.length ? <small>Complete a challenge to start building your skills. Every concept starts at Beginner I.</small>
      : <ul className="bp-pf-skills">{[...profile.skills].sort((a, b) => rankOf(b.level) - rankOf(a.level) || b.xp - a.xp).map(skill => <SkillRow key={skill.concept} skill={skill} />)}</ul>}
  </section>;
}
function GrowthSection({ profile }: { profile: PublicProfile }) {
  return <>
    {!!profile.refresherDue.length && <section className="bp-v2-card bp-pf-card"><h2>Time to refresh</h2><small>Skill strength fades without practice. A quick refresher brings it back.</small>
      <ul className="bp-pf-chips">{profile.refresherDue.map(item => <li key={item.concept} className="bp-pf-chip is-warn">{conceptName(item.concept)}</li>)}</ul></section>}
    {!!profile.topInDemand.length && <section className="bp-v2-card bp-pf-card"><h2>In demand right now</h2>
      <ul className="bp-pf-demand">{profile.topInDemand.slice(0, 3).map(item => <li key={item.concept}><h3>{conceptName(item.concept)}</h3><small>{item.reason}</small>
        {safeVideo(item.videoUrl) && <a href={item.videoUrl} target="_blank" rel="noreferrer">Watch a tutorial →</a>}</li>)}</ul></section>}
  </>;
}
function TeammateCard({ person, onView }: { person: PublicProfile['complements'][number]; onView?(): void }) {
  const [lead = person.why, ...rest] = person.why.split('. ');
  return <li className="bp-pf-mate">
    <Avatar name={person.displayName} />
    <div className="bp-pf-mate-text"><h3>{person.displayName}</h3><p>{lead}{lead.endsWith('.') ? '' : '.'}</p>{!!rest.length && <small>{rest.join('. ')}</small>}</div>
    {onView && <button type="button" className="bp-pf-view" onClick={onView} aria-label={`View ${person.displayName}'s profile`}>View</button>}
  </li>;
}
function TeammatesSection({ profile, onViewProfile }: { profile: PublicProfile; onViewProfile?(accountId: string): void }) {
  return <section className="bp-v2-card bp-pf-card"><h2>Complementary teammates</h2>
    <small>People strong where you're still learning, and who can learn from you. Great for pairing, hackathons and study buddies.</small>
    {!profile.complements.length ? <p className="bp-pf-empty">No matches yet. Keep practicing — matches appear as your skills grow.</p>
      : <ul className="bp-pf-mates">{profile.complements.map(person => <TeammateCard key={person.accountId} person={person} onView={onViewProfile ? () => onViewProfile(person.accountId) : undefined} />)}</ul>}
  </section>;
}
export function ProfileView({ profile, onViewProfile, heroExtra }: { profile: PublicProfile; onViewProfile?(accountId: string): void; heroExtra?: ReactNode }) {
  const [tab, setTab] = useState<'skills' | 'teammates'>('skills');
  return <article className="bp-v2 bp-pf" aria-label="Skill profile">
    <Hero profile={profile} extra={heroExtra} />
    {!!profile.highlights.length && <ul className="bp-pf-chips bp-pf-highlights" aria-label="Highlights">{profile.highlights.slice(0, 3).map(item => <li key={item} className="bp-pf-chip">{item}</li>)}</ul>}
    <div className="bp-pf-tabs" role="tablist" aria-label="Profile sections">
      <button type="button" role="tab" aria-selected={tab === 'skills'} onClick={() => setTab('skills')}>Skills</button>
      <button type="button" role="tab" aria-selected={tab === 'teammates'} onClick={() => setTab('teammates')}>Teammates{profile.complements.length ? ` · ${profile.complements.length}` : ''}</button>
    </div>
    {tab === 'skills' ? <><SkillsSection profile={profile} /><GrowthSection profile={profile} /></> : <TeammatesSection profile={profile} onViewProfile={onViewProfile} />}
  </article>;
}
function TeammateProfile({ accountId, me, why, onBack }: { accountId: string; me: PublicProfile | null; why: string; onBack(): void }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null); setError('');
    void get(`/v2/profile/${encodeURIComponent(accountId)}/public`, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setProfile(profileSchema.parse(data));
    }).catch(cause => { if (!controller.signal.aborted) setError(loadError(cause)); });
    return () => controller.abort();
  }, [accountId]);
  const mine = new Map((me?.skills ?? []).map(skill => [skill.concept, rankOf(skill.level)]));
  const theyTeach = (profile?.skills ?? []).filter(s => rankOf(s.level) >= STRONG && (mine.get(s.concept) ?? 0) < STRONG).slice(0, 3);
  const theirs = new Map((profile?.skills ?? []).map(skill => [skill.concept, rankOf(skill.level)]));
  const youTeach = (me?.skills ?? []).filter(s => rankOf(s.level) >= STRONG && (theirs.get(s.concept) ?? 0) < STRONG).slice(0, 3);
  const connect = () => {
    if (!profile) return;
    const first = profile.displayName.split(' ')[0];
    const learn = theyTeach.map(s => conceptName(s.concept));
    const give = youTeach.map(s => conceptName(s.concept));
    const message = `Hi ${first}! I'm ${me?.displayName ?? 'a learner'} on Breakpoint.`
      + (learn.length ? ` You're strong in ${learn.join(', ')}, which I'm working on.` : '')
      + (give.length ? ` I can help with ${give.join(', ')} in return.` : '')
      + ' Want to pair up on a project or hackathon and learn from each other?';
    void navigator.clipboard.writeText(message).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }).catch(() => setError('Could not copy to the clipboard.'));
  };
  return <div className="bp-v2 bp-pf">
    <nav className="bp-pf-nav"><button type="button" className="bp-pf-back" onClick={onBack} aria-label="Back to your profile">← Back</button></nav>
    {error ? <div role="alert"><p>{error}</p></div> : !profile ? <p role="status">Loading profile…</p> : <>
      <Hero profile={profile} />
      <section className="bp-v2-card bp-pf-card bp-pf-match"><h2>Why you match</h2><small>{why}</small>
        <div className="bp-pf-swap">
          <div><h3>They can teach you</h3>{theyTeach.length ? <ul className="bp-pf-chips">{theyTeach.map(s => <li key={s.concept} className="bp-pf-chip is-good">{conceptName(s.concept)}</li>)}</ul> : <small>Nothing yet</small>}</div>
          <div><h3>You can teach them</h3>{youTeach.length ? <ul className="bp-pf-chips">{youTeach.map(s => <li key={s.concept} className="bp-pf-chip">{conceptName(s.concept)}</li>)}</ul> : <small>Nothing yet</small>}</div>
        </div>
        <button type="button" className="bp-pf-connect" onClick={connect}>{copied ? '✓ Intro copied — paste it in a DM' : `Connect with ${profile.displayName.split(' ')[0]}`}</button>
        <small>Copies a short intro message you can send them.</small>
      </section>
      <SkillsSection profile={profile} />
    </>}
  </div>;
}
function PublicToggle({ profile, onChange }: { profile: PublicProfile; onChange(next: boolean): void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <label className="bp-pf-public"><input type="checkbox" role="switch" checked={profile.public} disabled={busy} onChange={event => {
    const next = event.target.checked; setBusy(true); setFailed(false);
    void fetch(`${base}/v2/profile/${encodeURIComponent(profile.accountId)}/public`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: next }) })
      .then(response => { if (!response.ok) throw new Error(); onChange(next); }).catch(() => setFailed(true)).finally(() => setBusy(false));
  }} /><span>{profile.public ? 'Visible to teammates' : 'Hidden from teammates'}</span>{failed && <small role="alert">Could not save.</small>}</label>;
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
  const header = <header className="bp-pf-top"><strong className="bp-pf-brand">Breakpoint</strong>
    {!!accounts.length && <label className="bp-pf-account"><span>Test account</span><select value={account} onChange={event => {
      const accountId = event.target.value;
      setProfile(null); setViewing(null); setAccount(accountId); setSavingError('');
      void persist(() => prefs.setActiveAccount(accountId)).catch(() => setSavingError('Account selection could not be saved.'));
    }}>{accounts.map(item => <option key={item.accountId} value={item.accountId}>{item.displayName}</option>)}</select></label>}
  </header>;
  if (viewing) {
    const why = profile?.complements.find(person => person.accountId === viewing)?.why ?? '';
    return <main className="bp-v2 bp-v2-profile">{header}<TeammateProfile accountId={viewing} me={profile} why={why} onBack={() => setViewing(null)} /></main>;
  }
  return <main className="bp-v2 bp-v2-profile">{header}
    {error ? <div role="alert" className="bp-pf-error"><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div>
      : profile ? <ProfileView profile={profile} onViewProfile={setViewing} heroExtra={<PublicToggle profile={profile} onChange={() => setReload(value => value + 1)} />} />
      : <p role="status">Loading profile…</p>}
    {storageReady && <LearnerSettings value={settings} onChange={value => {
      setSettings(value); setSavingError('');
      void persist(() => prefs.saveLearnerSettings(value)).catch(() => setSavingError('Practice settings could not be saved.'));
    }} />}{savingError && <p role="alert">{savingError}</p>}
  </main>;
}
