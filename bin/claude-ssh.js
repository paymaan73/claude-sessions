#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { input, password as passwordPrompt, number } from '@inquirer/prompts';
import { connect, defaultKey, sftp, resume } from '../src/ssh.js';
import { listSessions, ProjectsDirNotFound } from '../src/sessions.js';
import { c, banner, spinner, theme, sessionChoices, resumeCard } from '../src/ui.js';
import { pickSession } from '../src/picker.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));

const HELP = `
${c.orange('✻')} ${c.bold('claude-ssh')} ${c.gray('v' + pkg.version)}

Connects to a machine over SSH, lists its Claude Code sessions and
resumes the one you pick in your terminal.

${c.bold('Usage')}
  claude-ssh ${c.peach('[user@]host')} ${c.gray('[options] [-- claude args]')}

${c.bold('Options')}
  ${c.peach('-p, --port')} <n>        SSH port ${c.gray('(default 22)')}
  ${c.peach('-u, --user')} <name>     SSH username
  ${c.peach('-i, --identity')} <file> Private key ${c.gray('(asks for password if no key works)')}
  ${c.peach('-d, --dir')} <path>      Claude projects folder on the server ${c.gray('(default ~/.claude/projects)')}
  ${c.peach('-P, --project')} <text>  Start with the list filtered by project / title
  ${c.peach('-n, --limit')} <n>       Max sessions to show ${c.gray('(default 50)')}
  ${c.peach('-h, --help')}            Show this help

${c.bold('Examples')}
  ${c.gray('$')} claude-ssh ubuntu@203.0.113.10
  ${c.gray('$')} claude-ssh 203.0.113.10 -p 2222 -- --dangerously-skip-permissions
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p' },
    user: { type: 'string', short: 'u' },
    identity: { type: 'string', short: 'i' },
    limit: { type: 'string', short: 'n' },
    dir: { type: 'string', short: 'd' },
    project: { type: 'string', short: 'P' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write(HELP + '\n');
  process.exit(0);
}

async function main() {
  const [target, ...claudeArgs] = positionals;
  banner(pkg.version);

  let host = target;
  let username = values.user;
  if (host && host.includes('@')) [username, host] = host.split('@');

  host ||= await input({ message: 'Server IP / host', required: true, theme });
  username ||= await input({ message: 'Username', default: process.env.USER || 'root', theme });
  const port = values.port
    ? Number(values.port)
    : target
      ? 22
      : await number({ message: 'Port', default: 22, theme });
  const where = `${username}@${host}${port === 22 ? '' : ':' + port}`;

  const keyPath = values.identity || defaultKey();
  const privateKey = keyPath ? fs.readFileSync(keyPath) : undefined;

  let conn;
  let spin = spinner(`Connecting to ${c.bold(where)}`);
  try {
    // Try key/agent first; fall back to asking for a password.
    if (!privateKey && !process.env.SSH_AUTH_SOCK) throw new Error('no key');
    conn = await connect({ host, port, username, privateKey });
    spin.succeed(`Connected to ${c.bold(where)} ${c.gray('· ssh key')}`);
  } catch (err) {
    spin.stop();
    if (err.level && err.level !== 'client-authentication' && err.message !== 'no key') throw err;
    const password = await passwordPrompt({ message: `Password for ${where}`, mask: '•', theme });
    spin = spinner(`Connecting to ${c.bold(where)}`);
    try {
      conn = await connect({ host, port, username, password });
    } catch (e) {
      spin.fail(`Could not connect to ${c.bold(where)}`);
      throw e;
    }
    spin.succeed(`Connected to ${c.bold(where)} ${c.gray('· password')}`);
  }

  const sftpSession = await sftp(conn);
  let dir = values.dir;
  let found;
  while (!found) {
    spin = spinner('Reading Claude Code sessions');
    try {
      found = await listSessions(sftpSession, { limit: Number(values.limit) || 50, dir });
    } catch (e) {
      if (!(e instanceof ProjectsDirNotFound)) {
        spin.fail('Could not read sessions');
        throw e;
      }
      spin.fail(`No projects folder at ${c.bold(e.tried.join(c.gray(' or ')))}`);
      dir = await input({
        message: 'Path to the Claude projects folder on the server',
        default: dir || '~/.claude/projects',
        theme,
      });
    }
  }
  const { sessions, home, root, projects } = found;
  if (!sessions.length) {
    spin.fail(`No Claude Code sessions in ${c.bold(root.replace(home, '~'))}`);
    conn.end();
    process.exit(1);
  }
  spin.succeed(
    `Found ${c.bold(sessions.length)} session${sessions.length > 1 ? 's' : ''} ${c.gray(
      `in ${projects} project${projects > 1 ? 's' : ''}`
    )} ${c.gray('· ' + root.replace(home, '~'))}`
  );
  console.log();

  const { header, rows } = sessionChoices(sessions, home);
  const session = await pickSession({
    message: 'Pick a session',
    header,
    rows,
    initial: values.project,
    pageSize: Math.max(5, Math.min(12, (process.stdout.rows || 30) - 16)),
    theme,
  });

  resumeCard(session, where, home);
  const code = await resume(conn, session, claudeArgs);
  conn.end();
  console.log(`\n${c.orange('✻')} ${c.gray(`Session closed · disconnected from ${where}`)}\n`);
  process.exit(code);
}

main().catch((err) => {
  if (err.name === 'ExitPromptError') {
    console.log(`\n${c.gray('Bye 👋')}`);
    process.exit(130);
  }
  console.error(`\n${c.red('✖')} ${err.message}\n`);
  process.exit(1);
});
