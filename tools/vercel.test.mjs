import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runVercel, runtimeEnv } from './vercel.mjs';

const settings = JSON.parse(readFileSync(new URL('./vercel-project-settings.json', import.meta.url), 'utf8'));
const env = {
  VERCEL_TOKEN: 'deploy-fixture-secret', VERCEL_ORG_ID: 'team_fixture', VERCEL_PROJECT_ID: 'prj_fixture',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
  LLM_PROVIDER: 'openai', LLM_MODEL: 'fixture-model', OPENAI_API_KEY: 'model-fixture-secret',
  ANTHROPIC_API_KEY: 'unused-model-secret', SUPABASE_ACCESS_TOKEN: 'management-fixture-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-fixture-secret', VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-fixture-secret',
};
const project = { ...settings, id: env.VERCEL_PROJECT_ID, accountId: env.VERCEL_ORG_ID };

function fakeCli(response = project) {
  const calls = [];
  return {
    calls,
    execute(args, childEnv, input) {
      calls.push({ args, childEnv, input });
      return args[0] === 'deploy' ? 'https://fixture.vercel.app' : JSON.stringify(response);
    },
  };
}

test('runtime sync selects one model and excludes management, cloud and deployment secrets', () => {
  assert.deepEqual(runtimeEnv(env).map(item => item.key), [
    'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'LLM_PROVIDER', 'LLM_MODEL', 'OPENAI_API_KEY',
  ]);
  assert.throws(() => runtimeEnv({ ...env, LLM_MODEL: '' }), /Missing LLM_MODEL/);
});

test('missing credentials or an invalid deployment target make no network changes', () => {
  const cli = fakeCli();
  assert.throws(() => runVercel('configure', undefined, {}, cli.execute), /Missing VERCEL_TOKEN/);
  assert.throws(() => runVercel('env', 'all', env, cli.execute), /Choose preview or production/);
  assert.equal(cli.calls.length, 0);
});

test('project owner mismatch stops before a configuration update', () => {
  const cli = fakeCli({ ...project, accountId: 'team_other' });
  assert.throws(() => runVercel('configure', undefined, env, cli.execute), /owner mismatch/);
  assert.equal(cli.calls.length, 1);
});

test('configuration uses the scoped project and enables access to the shared build helper', () => {
  const cli = fakeCli();
  runVercel('configure', undefined, env, cli.execute);
  assert.match(cli.calls[1].args[1], /prj_fixture\?teamId=team_fixture/);
  assert.ok(cli.calls[1].args.includes('PATCH'));
  assert.equal(settings.rootDirectory, 'web');
  assert.equal(settings.sourceFilesOutsideRootDirectory, true);
  assert.equal(settings.nodeVersion, '24.x');
  assert.ok(!JSON.stringify(cli.calls.map(call => call.args)).includes(env.VERCEL_TOKEN));
  assert.equal(cli.calls.length, 3);
});

test('configuration is not reported as complete when read-back settings differ', () => {
  const cli = fakeCli({ ...project, rootDirectory: 'wrong-root' });
  assert.throws(() => runVercel('configure', undefined, env, cli.execute), /did not return the expected/);
});

test('env sync sends values on stdin and reports names only', () => {
  const cli = fakeCli();
  const result = runVercel('env', 'preview', env, cli.execute);
  const model = cli.calls.find(call => call.args.includes('OPENAI_API_KEY'));
  assert.equal(model.input, env.OPENAI_API_KEY);
  assert.ok(model.args.includes('--sensitive'));
  assert.ok(!JSON.stringify(cli.calls.map(call => call.args)).includes(env.OPENAI_API_KEY));
  assert.doesNotMatch(result, /model-fixture-secret|deploy-fixture-secret/);
  assert.equal(cli.calls.length, 6);
});

test('partial env sync names the failed variable without returning CLI secrets', () => {
  const cli = fakeCli();
  assert.throws(() => runVercel('env', 'preview', env, (args, childEnv, input) => {
    if (args.includes('OPENAI_API_KEY')) throw new Error(env.OPENAI_API_KEY);
    return cli.execute(args, childEnv, input);
  }), error => {
    assert.match(error.message, /Could not sync OPENAI_API_KEY to preview/);
    assert.doesNotMatch(error.message, /model-fixture-secret/);
    return true;
  });
});

test('preview deploy targets the verified project without passing the token in arguments', () => {
  const cli = fakeCli();
  assert.match(runVercel('deploy', 'preview', env, cli.execute), /https:\/\/fixture.vercel.app/);
  assert.deepEqual(cli.calls[1].args, ['deploy', '--project', 'prj_fixture', '--environment', 'preview', '--yes', '--team', 'team_fixture']);
  assert.equal(cli.calls[1].childEnv.VERCEL_TOKEN, env.VERCEL_TOKEN);
});

test('untrusted API errors cannot leak their response content', () => {
  assert.throws(() => runVercel('check', undefined, env, () => { throw new Error(env.VERCEL_TOKEN); }), error => {
    assert.doesNotMatch(error.message, /deploy-fixture-secret/);
    return /Could not verify/.test(error.message);
  });
});
