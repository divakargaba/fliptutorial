// Offline GitHub CLI test double. Never contacts a service or reads real credentials.
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.BOARD_TEST_FIXTURE;
if (!file) throw new Error('This fixture is only for tools tests');
const data = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
data.calls.push(args);
const save = () => writeFileSync(file, JSON.stringify(data));
const output = value => { save(); process.stdout.write(String(value) + '\n'); };
const fail = message => { save(); process.stderr.write(message + '\n'); process.exit(1); };
const argument = name => args[args.indexOf(name) + 1];

if (args[0] === 'auth') {
  if (data.failAuth) fail('Simulated auth failure');
  output('Logged in');
} else if (args[0] === 'repo' && args[1] === 'view') output('team/hackathon');
else if (args[0] === 'issue') {
  if (args[1] === 'list') output(data.issues.filter(i => i.title === 'Message Board').map(i => i.number).join('\n'));
  else if (args[1] === 'view') output('OPEN');
  else if (args[1] === 'pin') { data.pinned = Number(args[2]); output('Pinned'); }
  else if (args[1] === 'create') {
    const issue = { number:data.issues.length + 1, title:argument('--title'), body:readFileSync(argument('--body-file'), 'utf8') };
    data.issues.push(issue);
    output(`https://github.com/team/hackathon/issues/${issue.number}`);
  } else fail('Unexpected issue command');
} else if (args[0] === 'api') {
  const endpoint = args.find(arg => arg === 'user' || arg.startsWith('repos/'));
  if (endpoint === 'user') {
    if (data.failAuth) fail('Simulated auth failure');
    output(data.login);
  } else if (!endpoint.includes('/comments')) output(data.comments.length);
  else if (args.includes('-f')) {
    const post = { id:Math.max(7000000000, ...data.comments.map(c => c.id)) + 1, body:argument('-f').slice(5), user:{ login:data.login }, created_at:'2026-11-03T12:00:00Z' };
    data.comments.push(post);
    output(post.id);
  } else {
    if (data.failComments) fail('Simulated API failure');
    const query = argument('--jq');
    const last = Number(query.match(/select\(\.id > (\d+)\)/)?.[1] || 0);
    const page = Number(new URL('https://example.test/' + endpoint).searchParams.get('page') || 1);
    const candidates = args.includes('--paginate') ? data.comments : data.comments.slice((page - 1) * 100, page * 100);
    const mention = new RegExp(`(^|[^A-Za-z0-9_-])@(${data.login}|all)([^A-Za-z0-9_-]|$)`, 'i');
    output(candidates.filter(c => c.id > last).map(c => `\x1e${c.id}\t${c.created_at}\t${c.user.login}\t${mention.test(c.body) ? 1 : 0}\n${c.body}`).join('\n'));
  }
} else fail('Unexpected fake gh invocation: ' + JSON.stringify(args));
