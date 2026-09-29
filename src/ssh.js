import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'ssh2';

export function connect({ host, port, username, password, privateKey, passphrase }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) =>
        finish(prompts.map(() => password || ''))
      )
      .connect({
        host,
        port,
        username,
        password,
        privateKey,
        passphrase,
        agent: process.env.SSH_AUTH_SOCK,
        tryKeyboard: Boolean(password),
        readyTimeout: 20000,
        keepaliveInterval: 15000,
      });
  });
}

export function defaultKey() {
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const p = path.join(os.homedir(), '.ssh', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function sftp(conn) {
  return new Promise((resolve, reject) => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Run `claude --resume <id>` on the remote side in a real PTY, wired to our terminal. */
export function resume(conn, session, extraArgs = []) {
  // `claude` may not be on PATH for a non-interactive login (e.g. installed with nvm under
  // a non-default Node), so fall back to the usual install locations, newest nvm Node last.
  const inner = [
    session.cwd ? `cd -- ${q(session.cwd)} || exit 1;` : '',
    'c=$(command -v claude || ls -1d ~/.local/bin/claude ~/.claude/local/claude ~/.nvm/versions/node/*/bin/claude 2>/dev/null | sort -V | tail -n 1);',
    '[ -n "$c" ] || { echo "claude-ssh: claude not found on this server" >&2; exit 127; };',
    'PATH="$(dirname "$c"):$PATH" exec "$c" --resume',
    q(session.id),
    ...extraArgs.map(q),
  ].join(' ');
  // Login + interactive shell so PATH from ~/.profile / ~/.bashrc / ~/.zshrc is loaded.
  const cmd = `exec "\${SHELL:-/bin/sh}" -lic ${q(inner)}`;

  const { stdin, stdout, stderr } = process;
  const pty = {
    term: process.env.TERM || 'xterm-256color',
    rows: stdout.rows || 24,
    cols: stdout.columns || 80,
  };

  return new Promise((resolve, reject) => {
    conn.exec(cmd, { pty }, (err, stream) => {
      if (err) return reject(err);

      const onResize = () => stream.setWindow(stdout.rows, stdout.columns, 0, 0);
      stdout.on('resize', onResize);
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.pipe(stream);
      stream.pipe(stdout);
      stream.stderr.pipe(stderr);

      stream.on('close', (code) => {
        stdout.off('resize', onResize);
        stdin.unpipe(stream);
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        resolve(code ?? 0);
      });
    });
  });
}
