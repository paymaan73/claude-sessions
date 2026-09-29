const { stdout, env } = process;

const colorLevel =
  env.NO_COLOR || !stdout.isTTY ? 0 : /truecolor|24bit/i.test(env.COLORTERM || '') ? 3 : 2;

const wrap = (open, close) => (s) => (colorLevel ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const rgb = (r, g, b, ansi256) =>
  wrap(colorLevel === 3 ? `38;2;${r};${g};${b}` : `38;5;${ansi256}`, 39);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  orange: rgb(217, 119, 87, 173), // Claude clay
  peach: rgb(235, 170, 140, 216),
  green: rgb(120, 190, 120, 114),
  red: rgb(230, 100, 100, 167),
  gray: rgb(140, 140, 140, 245),
  slate: rgb(110, 118, 129, 243),
};

export const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// Rough terminal width: wide CJK/emoji take two cells, combining marks take none.
export function width(s) {
  let w = 0;
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0);
    if (/\p{Mn}|\p{Me}|‍|️/u.test(ch)) continue;
    w += (cp >= 0x1100 && /\p{Emoji_Presentation}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/u.test(ch)) ? 2 : 1;
  }
  return w;
}

export function fit(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  if (width(s) <= n) return s + ' '.repeat(n - width(s));
  let out = '';
  for (const ch of s) {
    if (width(out + ch) > n - 1) break;
    out += ch;
  }
  return out + '…' + ' '.repeat(Math.max(0, n - 1 - width(out)));
}

export const cols = () => Math.min(stdout.columns || 100, 120);

export function banner(version) {
  const inner = 46;
  const line = (s = '') => `${c.slate('│')} ${s}${' '.repeat(Math.max(0, inner - width(s)))}${c.slate('│')}`;
  const title = `${c.orange('✻')}  ${c.bold('claude-ssh')} ${c.gray('v' + version)}`;
  console.log(
    [
      '',
      c.slate(`╭${'─'.repeat(inner + 1)}╮`),
      line(),
      line(title),
      line(`   ${c.gray('resume your Claude Code sessions over SSH')}`),
      line(),
      c.slate(`╰${'─'.repeat(inner + 1)}╯`),
      '',
    ].join('\n')
  );
}

export function spinner(text) {
  const frames = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  let i = 0;
  const tty = stdout.isTTY;
  const render = () => stdout.write(`\r\x1b[2K${c.orange(frames[i++ % frames.length])} ${text}`);
  const timer = tty ? setInterval(render, 90) : null;
  if (tty) {
    stdout.write('\x1b[?25l');
    render();
  }
  const end = (icon, msg) => {
    if (timer) clearInterval(timer);
    stdout.write(`${tty ? '\r\x1b[2K\x1b[?25h' : ''}${icon} ${msg ?? text}\n`);
  };
  return {
    set: (t) => (text = t),
    succeed: (msg) => end(c.green('✔'), msg),
    fail: (msg) => end(c.red('✖'), msg),
    stop: () => {
      if (timer) clearInterval(timer);
      if (tty) stdout.write('\r\x1b[2K\x1b[?25h');
    },
  };
}

export const theme = {
  prefix: { idle: c.orange('◆'), done: c.green('✔') },
  icon: { cursor: c.orange('❯') },
  style: {
    answer: c.peach,
    message: (m) => c.bold(m),
    highlight: (s) => c.orange(c.bold(strip(s))),
    description: (s) => s,
    help: c.gray,
    key: (k) => c.peach(c.bold(k)),
    error: (t) => c.red(`  ✖ ${t}`),
    defaultAnswer: (t) => c.gray(`(${t})`),
  },
};

export function ago(date) {
  const s = Math.max(0, Math.round((Date.now() - date) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return date.toISOString().slice(0, 10);
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

const tildify = (p, home) => (home && p && p.startsWith(home) ? '~' + p.slice(home.length) : p);
const projectPath = (s, home) => tildify(s.cwd, home) || s.project;

// Like fit(), but keeps the end of the string: "…/work/api-server".
function fitLeft(s, n) {
  if (width(s) <= n) return s + ' '.repeat(n - width(s));
  const chars = [...s];
  let out = '';
  while (chars.length && width(out) < n - 1) out = chars.pop() + out;
  if (width(out) > n - 1) out = out.slice(1);
  return '…' + out + ' '.repeat(Math.max(0, n - 1 - width(out)));
}

/** Build aligned rows: title │ project path │ age, plus a lowercase haystack for filtering. */
export function sessionChoices(sessions, home) {
  const total = cols() - 4;
  const ageW = 10;
  const projW = Math.min(36, Math.max(8, ...sessions.map((s) => width(projectPath(s, home)))));
  const titleW = Math.max(20, total - projW - ageW - 4);

  const header = c.gray(`  ${fit('SESSION', titleW)}  ${fit('PROJECT', projW)}  ${'LAST USED'.padStart(ageW)}`);

  const rows = sessions.map((s) => {
    const title = s.title || s.prompt;
    const project = projectPath(s, home);
    return {
      value: s,
      short: `${fit(title, 50).trim()} ${c.gray('· ' + project)}`,
      name: `${fit(title, titleW)}  ${c.peach(fitLeft(project, projW))}  ${c.gray(ago(s.mtime).padStart(ageW))}`,
      haystack: [project, s.cwd, s.project, title, s.prompt, s.id].filter(Boolean).join(' ').toLowerCase(),
      description: [
        `  ${c.slate('dir')}  ${project}`,
        `  ${c.slate('id ')}  ${c.gray(s.id)}  ${c.slate('·')}  ${c.gray(bytes(s.size))}`,
        s.title && s.prompt ? `  ${c.slate('>  ')}  ${c.italic(c.gray(fit(s.prompt, total - 8).trim()))}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  });
  return { header, rows };
}

export function resumeCard(session, target, home) {
  const w = Math.min(cols() - 2, 72);
  const row = (label, value) => `${c.slate('│')} ${c.slate(label.padEnd(5))} ${value}`;
  console.log(
    [
      '',
      c.slate('╭─ ') + c.orange('resuming ') + c.slate('─'.repeat(Math.max(0, w - 12))),
      row('on', c.bold(target)),
      row('dir', tildify(session.cwd, home) || '~'),
      row('chat', fit(session.title || session.prompt, w - 9).trim()),
      c.slate('╰' + '─'.repeat(w - 1)),
      '',
    ].join('\n')
  );
}
