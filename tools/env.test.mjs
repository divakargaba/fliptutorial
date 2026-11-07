import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { readEnv } from './env.mjs';

function fixture(t, content = '') {
  const dir = mkdtempSync(join(tmpdir(), 'hackathon env test '));
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith('hackathon env test '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'tools'));
  copyFileSync(new URL('./env.mjs', import.meta.url), join(dir, 'tools/env.mjs'));
  writeFileSync(join(dir, '.env.example'), content);
  return { dir, run: (...args) => spawnSync(process.execPath, [join(dir, 'tools/env.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: {} }) };
}

test('env setup preserves existing credentials and omits empty optional values', t => {
  const f = fixture(t, 'TEST_TOKEN=first\nAWS_PROFILE=\n');
  assert.equal(f.run('init').status, 0);
  writeFileSync(join(f.dir, '.env.local'), 'TEST_TOKEN=existing\nAWS_PROFILE=\n');
  assert.equal(f.run('init').status, 0);
  assert.equal(readFileSync(join(f.dir, '.env.local'), 'utf8'), 'TEST_TOKEN=existing\nAWS_PROFILE=\n');
  assert.equal(readEnv(join(f.dir, '.env.local'), {}).AWS_PROFILE, undefined);
});

test('env values remain literal and process credentials take precedence', t => {
  const f = fixture(t);
  const file = join(f.dir, '.env.local');
  writeFileSync(file, 'TEST_TOKEN="literal $value # with spaces"\nOTHER=file\n');
  const env = readEnv(file, { OTHER: 'process' });
  assert.equal(env.TEST_TOKEN, 'literal $value # with spaces');
  assert.equal(env.OTHER, 'process');
});

test('readiness reports missing names without revealing configured tokens', t => {
  const f = fixture(t, 'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=publishable-fixture\nLLM_PROVIDER=openai\nOPENAI_API_KEY=private-fixture-token\n');
  assert.equal(f.run('init').status, 0);
  const result = f.run('check');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing LLM_MODEL/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-fixture-token|publishable-fixture|https:\/\/example/);
});

test('command wrapper passes credentials without printing them and preserves failure status', t => {
  const f = fixture(t, 'TEST_TOKEN=private-fixture-token\n');
  assert.equal(f.run('init').status, 0);
  const result = f.run('run', 'node', '-e', 'process.stdout.write(process.env.TEST_TOKEN === "private-fixture-token" ? "configured" : "missing"); process.exit(7)');
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'configured');
  assert.equal(result.stderr, '');
});
