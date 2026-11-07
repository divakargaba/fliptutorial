import { chmodSync, constants, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const localFile = fileURLToPath(new URL('../.env.local', import.meta.url));
const exampleFile = fileURLToPath(new URL('../.env.example', import.meta.url));

export function readEnv(file = localFile, inherited = process.env) {
  const parsed = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  // Literal values, no shell evaluation; existing process/CI credentials take precedence.
  return { ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value.trim() !== '')), ...inherited };
}

function check(env) {
  let incomplete = false;
  function group(label, keys, optional = false) {
    const missing = keys.filter(key => !env[key]);
    const absent = missing.length === keys.length;
    console.log(`${label}: ${optional && absent ? 'optional; not configured' : missing.length ? `missing ${missing.join(', ')}` : 'configured; access not verified'}`);
    if (missing.length && !(optional && absent)) incomplete = true;
  }
  group('Supabase app', ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']);
  const providers = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };
  if (!env.LLM_PROVIDER) console.log('LLM: choose LLM_PROVIDER and LLM_MODEL when AI is needed');
  else if (!Object.hasOwn(providers, env.LLM_PROVIDER)) {
    console.log('LLM: LLM_PROVIDER must be openai, anthropic, gemini or deepseek');
    incomplete = true;
  } else group('Selected LLM', ['LLM_MODEL', providers[env.LLM_PROVIDER]]);
  group('Supabase management', ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF'], true);
  if (env.AWS_PROFILE && (env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY || env.AWS_SESSION_TOKEN)) {
    console.log('AWS: choose AWS_PROFILE or direct credentials, then clear the other method');
    incomplete = true;
  } else if (env.AWS_PROFILE) group('AWS profile', ['AWS_PROFILE', 'AWS_REGION']);
  else group('AWS credentials', ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'], !env.AWS_SESSION_TOKEN);
  group('GitHub token (CLI login also works)', ['GH_TOKEN'], true);
  group('Vercel deployment', ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']);
  console.log('Only presence was checked. Verify real project/account permissions before use.');
  return incomplete ? 1 : 0;
}

async function main() {
  const [action, command, ...args] = process.argv.slice(2);
  if (action === 'init') {
    try {
      copyFileSync(exampleFile, localFile, constants.COPYFILE_EXCL);
      chmodSync(localFile, 0o600);
      console.log('Created root .env.local. Fill the credentials you need.');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.log('Kept existing root .env.local.');
    }
    return;
  }
  const env = readEnv();
  if (action === 'check') { process.exitCode = check(env); return; }
  if (action !== 'run' || !command) throw new Error('Usage: env.mjs init | check | run <command> [args]');
  // Run npm through its JS entry point so Windows never needs shell interpolation.
  const npmEntry = process.env.npm_execpath;
  if (command === 'npm' && !npmEntry) throw new Error('Run npm commands through npm run with-env.');
  const executable = command === 'node' || command === 'npm' ? process.execPath : command;
  const childArgs = command === 'npm' ? [npmEntry, ...args] : args;
  const child = spawn(executable, childArgs, { env, stdio: 'inherit', shell: false });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not start tool. Install it; use npm exec -- for npm-based tools.')));
    child.once('exit', code => resolve(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Environment command failed. Check file syntax, command and installed tools; credential values are hidden.'); process.exitCode = 1; });
}
