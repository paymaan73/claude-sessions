import path from 'node:path/posix';

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 32 * 1024;

const promisify = (fn) => (...args) =>
  new Promise((resolve, reject) => fn(...args, (err, res) => (err ? reject(err) : resolve(res))));

function readRange(sftp, file, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    sftp
      .createReadStream(file, { start, end })
      .on('data', (c) => chunks.push(c))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial line at a chunk boundary
    }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const part = content.find((p) => p && p.type === 'text' && typeof p.text === 'string');
    return part ? part.text : '';
  }
  return '';
}

// Turn a raw user message into a readable prompt: unwrap pasted content, drop
// command/system wrapper blocks, and strip any leftover tags.
function cleanPrompt(raw) {
  let t = raw
    .replace(/<pasted_content\b[^>]*>/gi, ' ')
    .replace(/<\/pasted_content>/gi, ' ')
    // whole wrapper blocks that carry no user intent
    .replace(
      /<(command-[a-z-]+|local-command-[a-z-]+|system-reminder|user-[a-z-]+|bash-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/gi,
      ' '
    )
    .replace(/<[^>]+>/g, ' '); // any remaining tags
  return t.replace(/\s+/g, ' ').trim();
}

function firstPrompt(entries) {
  for (const e of entries) {
    if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) continue;
    const text = cleanPrompt(textOf(e.message.content));
    if (text) return text;
  }
  return '';
}

function titleOf(entries) {
  let title = '';
  for (const e of entries) {
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    else if (e.type === 'summary' && e.summary && !title) title = e.summary;
  }
  return title;
}

export class ProjectsDirNotFound extends Error {
  constructor(tried) {
    super(`Claude projects folder not found (tried ${tried.join(', ')})`);
    this.tried = tried;
  }
}

// How Claude Code names a project's folder under ~/.claude/projects.
const encodeProject = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const isSessionFile = (name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(name);

/**
 * List Claude Code sessions on the remote machine by reading
 * ~/.claude/projects/<project>/<sessionId>.jsonl over SFTP.
 *
 * `dir` (absolute or ~-relative) may be a Claude config dir (~/.claude), its projects
 * folder, one project's session folder, or a project's working directory.
 */
export async function listSessions(sftp, { limit = 50, dir } = {}) {
  const readdir = promisify(sftp.readdir.bind(sftp));
  const realpath = promisify(sftp.realpath.bind(sftp));
  const tryReaddir = (p) => readdir(p).catch(() => null);

  const home = await realpath('.');
  const expand = (p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(home, p));
  const defaultRoots = [path.join(home, '.claude', 'projects'), path.join(home, '.config', 'claude', 'projects')];

  const jsonl = (folder, entries) =>
    entries
      .filter((f) => isSessionFile(f.filename))
      .map((f) => ({
        id: f.filename.slice(0, -'.jsonl'.length),
        file: path.join(folder, f.filename),
        project: path.basename(folder),
        mtime: new Date(f.attrs.mtime * 1000),
        size: f.attrs.size,
      }));

  async function scanRoot(root, entries) {
    const out = [];
    for (const p of entries) {
      if (!p.longname.startsWith('d')) continue;
      const folder = path.join(root, p.filename);
      const inner = await tryReaddir(folder);
      if (inner) out.push(...jsonl(folder, inner));
    }
    return out;
  }

  // Returns the sessions under `p`, or null when `p` can't be read.
  async function scan(p) {
    const entries = await tryReaddir(p);
    if (!entries) return null;
    if (entries.some((f) => isSessionFile(f.filename))) return jsonl(p, entries); // one project's folder
    if (path.basename(p) !== 'projects' && entries.some((f) => f.filename === 'projects')) {
      const nested = await scan(path.join(p, 'projects')); // a config dir like ~/.claude
      if (nested) return nested;
    }
    return scanRoot(p, entries);
  }

  let root;
  let files = null;
  const tried = [];
  const attempt = async (p) => {
    tried.push(p);
    const found = await scan(p);
    if (found && (found.length || !files)) {
      files = found;
      root = p;
    }
    return found && found.length;
  };

  if (dir) {
    const target = expand(dir);
    // A project's working directory: look up its session folder in the default locations.
    if (!(await attempt(target))) {
      for (const r of defaultRoots) if (await attempt(path.join(r, encodeProject(target)))) break;
    }
  } else {
    for (const r of defaultRoots) if (await attempt(r)) break;
  }
  if (!files) throw new ProjectsDirNotFound(tried);

  files.sort((a, b) => b.mtime - a.mtime);
  const recent = files.slice(0, limit);

  await Promise.all(
    recent.map(async (s) => {
      if (!s.size) return;
      const head = parseLines(await readRange(sftp, s.file, 0, Math.min(s.size, HEAD_BYTES) - 1));
      const tail =
        s.size > HEAD_BYTES
          ? parseLines(await readRange(sftp, s.file, Math.max(HEAD_BYTES, s.size - TAIL_BYTES), s.size - 1))
          : [];
      const all = head.concat(tail);
      s.cwd = (all.find((e) => typeof e.cwd === 'string') || {}).cwd;
      s.prompt = firstPrompt(head);
      s.title = titleOf(all);
      s.hasConversation = all.some((e) => e.type === 'user' && !e.isMeta && e.message);
    })
  );

  // Keep anything with a real message, even when no readable title/prompt could be
  // pulled out (e.g. it started with pasted content); drop only opened-and-closed stubs.
  const sessions = recent.filter((s) => s.prompt || s.title || s.hasConversation);
  return { sessions, home, root, projects: new Set(sessions.map((s) => s.project)).size };
}
