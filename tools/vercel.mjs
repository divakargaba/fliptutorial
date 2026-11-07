import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnv } from './env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const settingsFile = fileURLToPath(new URL('./vercel-project-settings.json', import.meta.url));
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
const providerKeys = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };

export function runtimeEnv(env) {
  const keys = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
  if (env.LLM_PROVIDER) {
    if (!Object.hasOwn(providerKeys, env.LLM_PROVIDER)) throw new Error('LLM_PROVIDER must be openai, anthropic, gemini or deepseek.');
    keys.push('LLM_PROVIDER', 'LLM_MODEL', providerKeys[env.LLM_PROVIDER]);
  }
  if (env.DEMO_ACCESS_TOKEN) keys.push('DEMO_ACCESS_TOKEN');
  const missing = keys.filter(key => !env[key]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}.`);
  return keys.map(key => ({ key, value: env[key], public: key.startsWith('NEXT_PUBLIC_') }));
}

function cli(args, env, input) {
  if (!process.env.npm_execpath) throw new Error('Use the npm run vercel:* commands.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'exec', '--yes', '--package=vercel@65.10.0', '--', 'vercel', ...args], {
    cwd: root, env, input, encoding: 'utf8', timeout: args[0] === 'deploy' ? 600_000 : 120_000, windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  // CLI responses can contain env values. Never echo raw stdout/stderr or errors.
  if (result.error || result.status !== 0) throw new Error('Vercel command failed. Check the token, team/project IDs, network and permissions; raw output is hidden.');
  return result.stdout;
}

export function runVercel(action, target, env, execute = cli) {
  if (!['check', 'configure', 'env', 'deploy'].includes(action)) throw new Error('Use vercel:check, vercel:configure, vercel:env or deploy:preview|production.');
  if (['env', 'deploy'].includes(action) && !['preview', 'production'].includes(target)) throw new Error('Choose preview or production explicitly.');
  const missing = ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'].filter(key => !env[key]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}.`);
  const values = action === 'env' ? runtimeEnv(env) : [];
  const scope = env.VERCEL_ORG_ID.startsWith('team_') ? `?teamId=${encodeURIComponent(env.VERCEL_ORG_ID)}` : '';
  const endpoint = `/v9/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}${scope}`;
  let project;
  try { project = JSON.parse(execute(['api', endpoint, '--raw'], env)); }
  catch { throw new Error('Could not verify the Vercel project. Check credentials, IDs and read permissions.'); }
  if (project.id !== env.VERCEL_PROJECT_ID || project.accountId !== env.VERCEL_ORG_ID) throw new Error('Vercel project/owner mismatch. No changes made.');
  if (action === 'check') {
    const different = Object.keys(settings).filter(key => (project[key] ?? null) !== settings[key]);
    return different.length ? `Project access verified. Settings to configure: ${different.join(', ')}.` : 'Project access verified; all template deployment settings match.';
  }
  if (action === 'configure') {
    execute(['api', endpoint, '--method', 'PATCH', '--input', settingsFile, '--silent'], env);
    let updated;
    try { updated = JSON.parse(execute(['api', endpoint, '--raw'], env)); }
    catch { throw new Error('Vercel settings were submitted but could not be verified. Run vercel:check.'); }
    if (updated.id !== env.VERCEL_PROJECT_ID || updated.accountId !== env.VERCEL_ORG_ID || Object.keys(settings).some(key => (updated[key] ?? null) !== settings[key])) {
      throw new Error('Vercel did not return the expected project settings. Run vercel:check before deployment.');
    }
    return 'Configured Next.js, web root, outside-root source files, Node 24 and build/install settings.';
  }
  const different = Object.keys(settings).filter(key => (project[key] ?? null) !== settings[key]);
  if (different.length) throw new Error('Deployment settings differ. Run npm run vercel:configure first.');
  if (action === 'deploy') {
    const args = ['deploy', '--project', env.VERCEL_PROJECT_ID, '--environment', target, '--yes'];
    if (env.VERCEL_ORG_ID.startsWith('team_')) args.push('--team', env.VERCEL_ORG_ID);
    const output = execute(args, env).trim();
    try {
      const url = new URL(output);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.app') || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error();
      return `${target} deployment completed: ${url.href}`;
    } catch { return 'Deployment command completed. Inspect the project in Vercel for its canonical URL before reporting it as verified.'; }
  }
  for (const item of values) {
    const args = ['env', 'add', item.key, '--project', env.VERCEL_PROJECT_ID, '--environment', target, '--force', item.public ? '--no-sensitive' : '--sensitive', '--yes'];
    if (env.VERCEL_ORG_ID.startsWith('team_')) args.push('--team', env.VERCEL_ORG_ID);
    try { execute(args, env, item.value); }
    catch { throw new Error(`Could not sync ${item.key} to ${target}. Earlier variables may have updated; check env-write permissions before retrying.`); }
  }
  return `Synced ${target} app variables: ${values.map(item => item.key).join(', ')}. Redeploy to apply.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(runVercel(process.argv[2], process.argv[3], readEnv())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
