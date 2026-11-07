import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const realGit = process.platform === 'win32'
  ? spawnSync('where.exe', ['git'], { encoding:'utf8' }).stdout.trim().split(/\r?\n/)[0]
  : spawnSync('which', ['git'], { encoding:'utf8' }).stdout.trim();

function fixture(t, comments = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hackathon board test '));
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith('hackathon board test '));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(join(repo, 'tools'), { recursive:true });
  mkdirSync(join(repo, '.github', 'ISSUE_TEMPLATE'), { recursive:true });
  mkdirSync(bin);
  for (const name of ['board','setup','autopilot']) copyFileSync(join(root, 'tools', name), join(repo, 'tools', name));
  copyFileSync(join(root, '.github', 'ISSUE_TEMPLATE', 'message-board.md'), join(repo, '.github', 'ISSUE_TEMPLATE', 'message-board.md'));
  copyFileSync(join(root, 'tools', 'fixtures', 'fake-gh.mjs'), join(bin, 'fake-gh.mjs'));
  writeFileSync(join(repo, '.board-issue'), '1\n');
  const store = join(dir, 'fixture.json');
  const data = { login:'mico', comments, issues:[{ number:1, title:'Message Board' }], calls:[] };
  writeFileSync(store, JSON.stringify(data));
  writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\nnode "$(dirname "$0")/fake-gh.mjs" "$@"\n', { mode:0o755 });
  writeFileSync(join(bin, 'codex'), '#!/usr/bin/env bash\nnode "$(dirname "$0")/fake-agent.mjs" "$@"\n', { mode:0o755 });
  writeFileSync(join(bin, 'fake-agent.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';\nconst f=process.env.BOARD_TEST_FIXTURE; const d=JSON.parse(readFileSync(f,'utf8')); d.agentArgs=process.argv.slice(2); writeFileSync(f,JSON.stringify(d)); for (const [p,c] of Object.entries(d.agentWrites||{})) writeFileSync(p,c); process.exit(d.failAgent?1:0);\n`);
  const upstream = join(dir, 'upstream.git');
  assert.equal(spawnSync(realGit, ['init','--bare','-q',upstream]).status, 0);
  for (const args of [['init','-q','-b','main'], ['remote','add','origin',upstream], ['add','.'], ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'], ['push','-qu','origin','main']]) {
    const result = spawnSync(realGit, args, { cwd:repo, encoding:'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const read = () => JSON.parse(readFileSync(store, 'utf8'));
  const update = changes => writeFileSync(store, JSON.stringify({ ...read(), ...changes }));
  function run(script, args = [], extra = {}, input) {
    return spawnSync(bash, [`tools/${script}`, ...args], {
      cwd:repo, encoding:'utf8', input, timeout:20_000,
      env:{ ...process.env, PATH:bin + delimiter + process.env.PATH, BOARD_REPO:'team/hackathon', BOARD_TEST_FIXTURE:store, ...extra },
    });
  }
  return { repo, read, update, run };
}

const post = (id, body, login = 'teammate') => ({ id, body, user:{ login }, created_at:'2026-11-03T11:00:00Z' });
function succeeds(result) { assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout; }

test('shell scripts parse before they are used', () => {
  for (const script of ['board','setup','autopilot']) {
    const result = spawnSync(bash, ['-n', `tools/${script}`], { cwd:root, encoding:'utf8' });
    succeeds(result);
  }
});

test('read is non-consuming, unread is incremental, and mentions match full logins', t => {
  const f = fixture(t, [post(7000000001, "[Sam] @all kickoff"), post(7000000002, "[Sam] @mico-other separate person"), post(7000000003, "[Sam] @mico please review")]);
  assert.match(succeeds(f.run('board', ['read','-n','20'])), /kickoff/);
  const fresh = succeeds(f.run('board', ['unread']));
  assert.equal((fresh.match(/<<< MENTION/g) || []).length, 2);
  assert.match(fresh, /separate person/);
  assert.equal(succeeds(f.run('board', ['unread'])).trim(), 'No new posts.');
  f.update({ comments:[...f.read().comments, post(7000000004, "[Sam] next update")] });
  const next = succeeds(f.run('board', ['unread']));
  assert.match(next, /next update/);
  assert.doesNotMatch(next, /kickoff/);
});

test('posting validates identity prefix, supports stdin, and wait ignores own posts', t => {
  const f = fixture(t);
  assert.notEqual(f.run('board', ['post','no prefix']).status, 0);
  assert.equal(f.read().comments.length, 0);
  assert.match(succeeds(f.run('board', ['post'], {}, "[Mico] @all own message")), /issuecomment-7000000001/);
  const own = f.run('board', ['wait','--interval','5','--timeout','1']);
  assert.equal(own.status, 2, own.stderr);
  assert.doesNotMatch(own.stdout, /own message/);
  f.update({ comments:[...f.read().comments, post(7000000002, "[Sam] @mico reply")] });
  assert.match(succeeds(f.run('board', ['wait','--timeout','1'])), /reply/);
});

test('reading recent history across a page boundary retains the requested posts', t => {
  const comments = Array.from({ length:105 }, (_,i) => post(7000000001 + i, `[Sam] update-${i + 1}`));
  const f = fixture(t, comments);
  const recent = succeeds(f.run('board', ['read','-n','20']));
  assert.equal((recent.match(/^--- @/gm) || []).length, 20);
  assert.match(recent, /update-86\b/);
  assert.match(recent, /update-105\b/);
  assert.doesNotMatch(recent, /update-85\b/);
});

test('issue overrides and consumer cursors are separate; API failures preserve unread work', t => {
  const f = fixture(t, [post(7000000001, "[Sam] @mico first")]);
  writeFileSync(join(f.repo, '.board-issue'), '7\r\n');
  assert.match(succeeds(f.run('board', ['unread'])), /first/);
  assert.ok(f.read().calls.some(args => args.some(value => value.includes('/issues/7'))));
  assert.match(succeeds(f.run('board', ['unread'], { BOARD_CONSUMER:'another-reader', BOARD_ISSUE:'9' })), /first/);
  f.update({ comments:[...f.read().comments, post(7000000002, "[Sam] @mico do not lose this")], failComments:true });
  assert.notEqual(f.run('board', ['unread']).status, 0);
  f.update({ failComments:false });
  assert.match(succeeds(f.run('board', ['unread'])), /do not lose this/);
  assert.notEqual(f.run('board', ['unread'], { BOARD_ISSUE:'bad' }).status, 0);
});

test('Claude hook failures never block the agent', t => {
  const f = fixture(t, [post(7000000001, "[Sam] message")]);
  f.update({ failAuth:true, failComments:true });
  assert.equal(f.run('board', ['hook','session']).status, 0);
});

test('setup creates and pins one board, and a second run reuses it', t => {
  const f = fixture(t);
  f.update({ issues:[] });
  assert.match(succeeds(f.run('setup')), /Board ready/);
  assert.equal(f.read().issues.length, 1);
  assert.equal(f.read().pinned, 1);
  assert.doesNotMatch(f.read().issues[0].body, /^---/);
  assert.match(succeeds(f.run('setup')), /Board ready/);
  assert.equal(f.read().issues.length, 1);
});

test('bounded runner uses current scoped Codex flags and stops on agent failure', t => {
  const f = fixture(t);
  succeeds(f.run('autopilot', ['--once','codex'], { AUTOPILOT_NAME:'Mico' }));
  const args = f.read().agentArgs;
  assert.deepEqual(args.slice(0,5), ['exec','--sandbox','workspace-write','-c','sandbox_workspace_write.network_access=true']);
  assert.match(args.at(-1), /coding agent for Mico \(@/);
  assert.match(args.at(-1), /in any phase including PREP/);
  assert.ok(!args.includes('--full-auto'));
  f.update({ failAgent:true });
  assert.notEqual(f.run('autopilot', ['--once','codex']).status, 0);
  assert.ok(!existsSync(join(f.repo, '.git','board','autopilot-codex.lock')));
});

test('codex runner commits, pushes and posts the agent handoff outside the sandbox', t => {
  const f = fixture(t);
  f.update({ agentWrites:{ 'feature.txt':'hello\n', '.autopilot/commit-msg':'Add feature\n', '.autopilot/post.md':'[Mico] @all feature done' } });
  const ident = { GIT_AUTHOR_NAME:'Mico', GIT_AUTHOR_EMAIL:'m@example.invalid', GIT_COMMITTER_NAME:'Mico', GIT_COMMITTER_EMAIL:'m@example.invalid' };
  succeeds(f.run('autopilot', ['--once','codex'], { AUTOPILOT_NAME:'Mico', ...ident }));
  const log = spawnSync(realGit, ['log','-1','--format=%s','origin/main'], { cwd:f.repo, encoding:'utf8' }).stdout.trim();
  assert.equal(log, 'Add feature');
  const status = spawnSync(realGit, ['status','--porcelain'], { cwd:f.repo, encoding:'utf8' }).stdout;
  assert.doesNotMatch(status, /feature|commit-msg/);
  const last = f.read().comments.at(-1).body;
  assert.match(last, /^\[Mico\] @all feature done\n\nCommit: [0-9a-f]{7}/);
});
