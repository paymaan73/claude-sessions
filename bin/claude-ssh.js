#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { input, password as passwordPrompt, number, confirm } from '@inquirer/prompts';
import { connect, defaultKey, sftp, resume } from '../src/ssh.js';
import { listSessions, ProjectsDirNotFound } from '../src/sessions.js';
import { c, banner, spinner, theme, sessionChoices, resumeCard, bytes } from '../src/ui.js';
import { copySession, localSessionFile } from '../src/copy.js';
import { pickSession } from '../src/picker.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));

const HELP = `
${c.orange('✻')} ${c.bold('claude-ssh')} ${c.gray('v' + pkg.version)}

Connects to a machine over SSH, lists its Claude Code sessions, copies
the one you pick to this machine and resumes it with your local Claude.

${c.bold('Usage')}
  claude-ssh ${c.peach('[user@]host')} ${c.gray('[options] [-- claude args]')}

${c.bold('Options')}
  ${c.peach('-p, --port')} <n>        SSH port ${c.gray('(default 22)')}
  ${c.peach('-u, --user')} <name>     SSH username
  ${c.peach('-i, --identity')} <file> Private key ${c.gray('(asks for password if no key works)')}
  ${c.peach('-d, --dir')} <path>      Claude projects folder on the server ${c.gray('(default ~/.claude/projects)')}
  ${c.peach('-r, --remote')}          Don't copy: run the session on the server over SSH
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
    remote: { type: 'boolean', short: 'r' },
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

  if (values.remote) {
    resumeCard(session, where, home);
    const code = await resume(conn, session, claudeArgs);
    conn.end();
    console.log(`\n${c.orange('✻')} ${c.gray(`Session closed · disconnected from ${where}`)}\n`);
    process.exit(code);
  }

  // Copy the session here and resume it with the local Claude Code.
  const localCwd = await pickLocalDir(session);
  const dest = localSessionFile(session, localCwd);
  const overwrite =
    !fs.existsSync(dest) ||
    (await confirm({ message: 'This session already exists here. Replace it with the server copy?', default: true, theme }));

  if (overwrite) {
    spin = spinner(`Copying session from ${c.bold(where)}`);
    try {
      const copied = await copySession(sftpSession, session, localCwd);
      spin.succeed(`Copied ${c.bold(bytes(copied.bytes))} ${c.gray('→ ' + tildify(copied.dest))}`);
    } catch (e) {
      spin.fail('Could not copy the session');
      throw e;
    }
  }
  conn.end();

  resumeCard({ ...session, cwd: localCwd }, 'this machine', os.homedir());
  const code = await runLocalClaude(session, localCwd, claudeArgs);
  console.log(`\n${c.orange('✻')} ${c.gray('Session closed')}\n`);
  process.exit(code);
}

const expandHome = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const tildify = (p) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Claude resumes a session from its project folder, so it needs a local counterpart.
async function pickLocalDir(session) {
  const suggested = session.cwd && isDir(session.cwd) ? session.cwd : process.cwd();
  const answer = await input({
    message: 'Local project folder',
    default: tildify(suggested),
    theme,
    validate: (p) => isDir(path.resolve(expandHome(p.trim()))) || 'That folder does not exist on this machine',
  });
  return path.resolve(expandHome(answer.trim()));
}

function runLocalClaude(session, cwd, args) {
  return new Promise((resolve) => {
    // Ctrl+C belongs to Claude while it runs; don't let it kill us.
    const ignore = () => {};
    process.on('SIGINT', ignore);
    const child = spawn('claude', ['--resume', session.id, ...args], { cwd, stdio: 'inherit' });
    child.on('error', (err) => {
      process.off('SIGINT', ignore);
      if (err.code === 'ENOENT') {
        console.error(`${c.red('✖')} Claude Code is not installed on this machine.`);
        console.error(`  Install it, then run: ${c.bold(`cd ${tildify(cwd)} && claude --resume ${session.id}`)}`);
        resolve(127);
      } else resolve(1);
    });
    child.on('exit', (code) => {
      process.off('SIGINT', ignore);
      resolve(code ?? 0);
    });
  });
}

main().catch((err) => {
  if (err.name === 'ExitPromptError') {
    console.log(`\n${c.gray('Bye 👋')}`);
    process.exit(130);
  }
  console.error(`\n${c.red('✖')} ${err.message}\n`);
  process.exit(1);
});
