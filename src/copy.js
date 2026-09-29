import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import rpath from 'node:path/posix';

const promisify = (fn) => (...args) =>
  new Promise((resolve, reject) => fn(...args, (err, res) => (err ? reject(err) : resolve(res))));

export const localClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// How Claude Code names a project's folder under ~/.claude/projects.
export const encodeProject = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export const localSessionFile = (session, localCwd) =>
  path.join(localClaudeDir(), 'projects', encodeProject(localCwd), `${session.id}.jsonl`);

function readAll(sftp, file) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    sftp
      .createReadStream(file)
      .on('data', (c) => chunks.push(c))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// Copies a remote directory tree; a missing source is not an error. Returns bytes copied.
async function downloadDir(sftp, from, to) {
  const readdir = promisify(sftp.readdir.bind(sftp));
  const fastGet = promisify(sftp.fastGet.bind(sftp));
  let entries;
  try {
    entries = await readdir(from);
  } catch {
    return 0;
  }
  fs.mkdirSync(to, { recursive: true });
  let bytes = 0;
  for (const e of entries) {
    const src = rpath.join(from, e.filename);
    const dst = path.join(to, e.filename);
    if (e.longname.startsWith('d')) bytes += await downloadDir(sftp, src, dst);
    else if (e.longname.startsWith('-')) {
      await fastGet(src, dst);
      bytes += e.attrs.size;
    }
  }
  return bytes;
}

// Point the transcript's working directory (and its subfolders) at the local project.
function retarget(text, fromCwd, toCwd) {
  if (!fromCwd || fromCwd === toCwd) return text;
  const from = `"cwd":${JSON.stringify(fromCwd).slice(0, -1)}`;
  const to = `"cwd":${JSON.stringify(toCwd).slice(0, -1)}`;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped + '(?=["/])', 'g'), to);
}

/**
 * Copy a remote session into the local Claude Code store so `claude --resume <id>`
 * works on this machine from `localCwd`.
 */
export async function copySession(sftp, session, localCwd) {
  const remoteProjectDir = rpath.dirname(session.file);
  const remoteClaudeDir = rpath.dirname(rpath.dirname(remoteProjectDir));
  const dest = localSessionFile(session, localCwd);
  const destDir = path.dirname(dest);

  fs.mkdirSync(destDir, { recursive: true });
  const transcript = retarget(await readAll(sftp, session.file), session.cwd, localCwd);
  fs.writeFileSync(dest, transcript);

  // Tool results / subagent transcripts, and file snapshots used by /rewind.
  let bytes = Buffer.byteLength(transcript);
  bytes += await downloadDir(sftp, rpath.join(remoteProjectDir, session.id), path.join(destDir, session.id));
  bytes += await downloadDir(
    sftp,
    rpath.join(remoteClaudeDir, 'file-history', session.id),
    path.join(localClaudeDir(), 'file-history', session.id)
  );
  return { dest, bytes };
}
