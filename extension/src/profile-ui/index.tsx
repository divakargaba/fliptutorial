import { useEffect, useState } from 'react';
import type { PublicProfile } from '../v2/types';
import levels from '../../../contracts/v2/levels.json';
import { ACCOUNT_KEY, conceptName, defaultSettings, LearnerSettings, SETTINGS_KEY, type LearnerSettingsValue } from '../ui/v2';
import { z } from 'zod';

const accountSchema = z.object({ accountId: z.string().min(1), displayName: z.string() });
const profileSchema = z.object({
  schemaVersion: z.literal(2), accountId: z.string(), displayName: z.string(), public: z.boolean(),
  skills: z.array(z.object({ concept: z.string(), level: z.string(), levelName: z.string(), xp: z.number().nonnegative(), strength: z.number().min(0).max(1), lastPracticedAt: z.string(), passed: z.number().nonnegative(), tutorials: z.number().nonnegative() })),
  highlights: z.array(z.string()), refresherDue: z.array(z.object({ concept: z.string(), reason: z.string() })),
  topInDemand: z.array(z.object({ concept: z.string(), reason: z.string(), videoUrl: z.string() })),
  complements: z.array(z.object({ accountId: z.string(), displayName: z.string(), why: z.string() })),
});
const settingsSchema = z.object({ frequency: z.enum(['few', 'normal', 'many']), autoPause: z.boolean(), disabledVideos: z.array(z.string()) });
export type LocalAccount = { accountId: string; displayName: string };
function storage() {
  const api = (globalThis as typeof globalThis & { chrome?: { storage?: { local?: {
    get(keys: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void>;
  } } } }).chrome?.storage?.local;
  if (!api) throw new Error('Local extension storage is unavailable.');
  return api;
}
let writeQueue = Promise.resolve();
function persist(values: Record<string, unknown>) {
  const next = writeQueue.catch(() => {}).then(() => storage().set(values));
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
  if (!response.ok) throw new Error(response.status === 501 ? 'Profiles are not available yet. Try again when the local profile service is ready.' : 'Could not load the local profile. Check that the backend is running.');
  return response.json();
}
function safeVideo(url: string) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && ['www.youtube.com', 'youtube.com', 'youtu.be'].includes(parsed.hostname); } catch { return false; }
}
export function ProfileView({ profile }: { profile: PublicProfile }) {
  return <article className="bp-v2" aria-label="Skill profile"><h1>{profile.displayName}</h1><p>{profile.public ? 'Public profile enabled' : 'Private profile'} · Local test account</p>
    <section className="bp-v2-card"><h2>Skills</h2>{!profile.skills.length && <p>Complete a challenge to start building your skills. Every concept starts at Beginner I.</p>}
      {profile.skills.map(skill => {
        const index = levels.levels.findIndex(level => level.id === skill.level);
        const current = levels.levels[index];
        const next = levels.levels[index + 1];
        const progress = current && next ? Math.max(0, Math.min(1, (skill.xp - current.minXp) / (next.minXp - current.minXp))) : 1;
        return <section className="bp-v2-skill" key={skill.concept}><h3>{conceptName(skill.concept)} · {skill.levelName}</h3>
          <label>{skill.xp} XP{next ? ` · Next: ${next.name} at ${next.minXp} XP` : ' · Highest level'}<progress aria-label={`${conceptName(skill.concept)} level progress`} value={progress} max={1} /></label>
          <label>Strength {Math.round(skill.strength * 100)}%<meter aria-label={`${conceptName(skill.concept)} strength`} value={skill.strength} min={0} max={1} low={0.35} high={0.7} optimum={1} /></label>
          <p>{skill.passed} challenges passed across {skill.tutorials} tutorials</p><small>Last practiced: {new Date(skill.lastPracticedAt).toLocaleDateString()}</small>
        </section>;
      })}</section>
    {!!profile.highlights.length && <section className="bp-v2-card"><h2>Highlights</h2><ul>{profile.highlights.map(item => <li key={item}>{item}</li>)}</ul></section>}
    {!!profile.refresherDue.length && <section className="bp-v2-card"><h2>Time to refresh</h2><p>Skill strength fades without practice. A refresher can help.</p><ul>{profile.refresherDue.map(item => <li key={item.concept}>{conceptName(item.concept)}: {item.reason}</li>)}</ul></section>}
    <section className="bp-v2-card"><h2>In-demand skills</h2>{!profile.topInDemand.length && <p>No recommendations yet.</p>}{profile.topInDemand.slice(0, 3).map(item => <div key={item.concept}><h3>{conceptName(item.concept)}</h3><p>{item.reason}</p>{safeVideo(item.videoUrl) && <a href={item.videoUrl} target="_blank" rel="noreferrer">Watch a tutorial on {conceptName(item.concept)}</a>}</div>)}</section>
    <section className="bp-v2-card"><h2>Complementary teammates</h2>{!profile.complements.length && <p>No complementary profiles yet.</p>}{profile.complements.map(person => <div key={person.accountId}><h3>{person.displayName}</h3><p>{person.why}</p></div>)}</section>
  </article>;
}
export function ProfilePage() {
  const [accounts, setAccounts] = useState<LocalAccount[]>([]);
  const [account, setAccount] = useState('');
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [error, setError] = useState('');
  const [savingError, setSavingError] = useState('');
  const [retry, setRetry] = useState(0);
  const [settings, setSettings] = useState<LearnerSettingsValue>(defaultSettings);
  const [storageReady, setStorageReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setProfile(null); setAccount('');
    const saved = storage().get([ACCOUNT_KEY, SETTINGS_KEY]).then(stored => {
      if (!controller.signal.aborted) {
        const parsed = settingsSchema.safeParse(stored[SETTINGS_KEY]);
        setSettings(parsed.success ? parsed.data : defaultSettings); setStorageReady(true);
      }
      return stored;
    });
    void Promise.all([get('/v2/accounts', controller.signal), saved]).then(([data, stored]) => {
      if (controller.signal.aborted) return;
      const parsed = z.union([z.array(accountSchema), z.object({ accounts: z.array(accountSchema) }).transform(value => value.accounts)]).parse(data);
      setAccounts(parsed);
      setAccount(parsed.some(item => item.accountId === stored[ACCOUNT_KEY]) ? stored[ACCOUNT_KEY] as string : parsed[0]?.accountId ?? '');
      if (!parsed.length) setError('No local test accounts are available yet.');
    }).catch(cause => { if (!controller.signal.aborted) setError(loadError(cause)); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    setProfile(null); setError('');
    void get(`/v2/profile/${encodeURIComponent(account)}`, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      const parsed = profileSchema.parse(data);
      if (parsed.accountId !== account) throw new Error('The profile did not match the selected account.');
      setProfile(parsed);
    }).catch(cause => { if (!controller.signal.aborted) setError(loadError(cause)); });
    return () => controller.abort();
  }, [account]);
  return <main className="bp-v2 bp-v2-profile"><header><strong>Breakpoint</strong></header>
    {!!accounts.length && <label className="bp-v2-setting">Test account<select value={account} onChange={event => {
      setAccount(event.target.value);
      void persist({ [ACCOUNT_KEY]: event.target.value }).catch(() => setSavingError('Account selection could not be saved.'));
    }}>{accounts.map(item => <option key={item.accountId} value={item.accountId}>{item.displayName}</option>)}</select></label>}
    {error ? <div role="alert"><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div> : profile ? <ProfileView profile={profile} /> : <p role="status">Loading profile…</p>}
    {storageReady && <LearnerSettings value={settings} onChange={value => {
      setSettings(value); setSavingError('');
      void persist({ [SETTINGS_KEY]: value }).catch(() => setSavingError('Practice settings could not be saved.'));
    }} />}{savingError && <p role="alert">{savingError}</p>}
  </main>;
}
