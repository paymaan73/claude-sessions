<div align="center">

# claude-ssh

**Bring Claude Code sessions from another machine to yours, and pick up where you left off.**

[![npm](https://img.shields.io/npm/v/claude-ssh-sessions?color=d97757)](https://www.npmjs.com/package/claude-ssh-sessions)
[![node](https://img.shields.io/node/v/claude-ssh-sessions?color=d97757)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-d97757)](#license)

</div>

`claude-ssh` connects to a server over SSH, lists the [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions stored there, copies the one you pick to your machine, and resumes it with your local Claude Code. The full conversation comes with it.

If you'd rather keep working on the server itself, `--remote` runs the session there in an interactive SSH terminal instead.

```text
╭───────────────────────────────────────────────╮
│ ✻  claude-ssh v1.0.0                          │
│    resume your Claude Code sessions over SSH  │
╰───────────────────────────────────────────────╯

✔ Connected to dev@devbox.example.com · ssh key
✔ Found 5 sessions in 3 projects · ~/.claude/projects

◆ Pick a session › api
  SESSION                                          PROJECT                   LAST USED
❯ Add rate limiting to the public API endpoints    ~/work/api-server            4m ago
  Fix flaky integration tests in CI                ~/work/api-server            2d ago
  Migrate API auth to short-lived JWTs             ~/work/api-gateway           6d ago

  dir  ~/work/api-server
  id   3f2b9c1e-8a4d-4e7b-9f10-2c6d5a7e8b90  ·  1.4 MB
↑↓ move  ·  type filter by project / title  ·  esc clear  ·  ⏎ resume   3/5 sessions

✔ Pick a session Add rate limiting to the public API endpoints · ~/work/api-server
✔ Local project folder ~/code/api-server
✔ Copied 1.4 MB → ~/.claude/projects/-home-me-code-api-server/3f2b9c1e-….jsonl
```

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Session lookup](#session-lookup)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Development](#development)
- [License](#license)

## Features

- **Copy, then continue locally.** The transcript, tool results and file snapshots (used by `/rewind`) are copied into your local `~/.claude`, with paths pointed at your local project folder.
- **Or stay remote.** `--remote` resumes the session on the server in a real PTY, with raw input and live resizing.
- **Key or password auth.** Uses your SSH agent or default key first, and asks for a password only if needed.
- **Nothing to install on the server.** Sessions are read over SFTP from `~/.claude/projects`.
- **Searchable session list.** Each session shows its title (or first prompt), project path and last activity. Type to filter.
- **Finds `claude` on the server** (with `--remote`). Checks the login shell's `PATH`, then falls back to common install locations, including nvm.

## Requirements

| Machine      | Requirement                                                   |
| ------------ | ------------------------------------------------------------- |
| Local        | Node.js 18 or later, and Claude Code                          |
| Remote       | An SSH server, and the Claude Code sessions you want          |
| Remote, with `--remote` | Claude Code installed for the SSH user             |

## Installation

```bash
npm install -g claude-ssh-sessions
```

Or run it without installing:

```bash
npx claude-ssh-sessions
```

## Quick start

```bash
claude-ssh dev@devbox.example.com
```

1. Authenticate with your key, or type the password when asked.
2. Use **↑ / ↓** to pick a session. Type to filter the list, and press **Esc** to clear the filter.
3. Press **Enter**, then confirm the **local project folder** for the session. By default this is the same path as on the server if it exists on your machine, and your current directory otherwise.
4. The session is copied and your local Claude Code opens with the conversation restored.

Your local copy is independent from the server's: new messages are saved only on your machine. Running it again for the same session asks before replacing your local copy.

Run `claude-ssh` with no arguments to be asked for the host, user, port and password.

## Usage

```text
claude-ssh [user@]host [options] [-- claude-args]
```

| Option                  | Description                                                        | Default              |
| ----------------------- | ------------------------------------------------------------------ | -------------------- |
| `-p, --port <n>`        | SSH port                                                           | `22`                 |
| `-u, --user <name>`     | SSH username (same as `user@host`)                                 | current user         |
| `-i, --identity <file>` | Private key file                                                   | `~/.ssh/id_*`        |
| `-r, --remote`          | Don't copy: resume the session on the server over SSH              |                      |
| `-d, --dir <path>`      | Where to look for sessions on the server ([details](#session-lookup)) | `~/.claude/projects` |
| `-P, --project <text>`  | Open the list already filtered by project or title                 |                      |
| `-n, --limit <n>`       | Maximum number of sessions shown, newest first                     | `50`                 |
| `-h, --help`            | Show help                                                          |                      |
| `-- <args>`             | Everything after `--` is passed to `claude`                        |                      |

### Examples

```bash
# Pick a session from the server and continue it here
claude-ssh dev@devbox.example.com

# Keep working on the server instead of copying
claude-ssh dev@devbox.example.com --remote

# Non-standard SSH port
claude-ssh dev@203.0.113.10 -p 2222

# Only sessions whose project or title matches "api-server"
claude-ssh dev@devbox.example.com -P api-server

# Sessions of one project, given its directory on the server
claude-ssh dev@devbox.example.com -d ~/work/api-server

# Use a specific key
claude-ssh dev@devbox.example.com -i ~/.ssh/work_ed25519

# Pass flags to Claude Code
claude-ssh dev@devbox.example.com -- --model opus
```

## Session lookup

Claude Code stores each session at:

```text
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

By default `claude-ssh` looks in `~/.claude/projects`, then in `~/.config/claude/projects`. Use `--dir` to point it somewhere else. The path can be absolute, or relative to the SSH user's home directory (`~` is supported):

| `--dir` value                               | Sessions listed        |
| ------------------------------------------- | ---------------------- |
| `~/.claude`                                 | All projects           |
| `~/.claude/projects`                        | All projects           |
| `~/.claude/projects/-home-dev-work-api`     | That project only      |
| `~/work/api` (the project's own directory)  | That project only      |

If no sessions folder is found, `claude-ssh` asks for the path instead of exiting.

## How it works

1. **Connect.** An SSH connection is opened with [`ssh2`](https://github.com/mscdex/ssh2), using agent or key authentication first and falling back to password or keyboard-interactive authentication.
2. **Discover.** Session files are listed over SFTP. Only the start and end of each file are read to get the working directory, the title and the first prompt, so large sessions stay fast.
3. **Copy** (default). Over SFTP, these are copied into your local Claude Code folder (`$CLAUDE_CONFIG_DIR`, or `~/.claude`):

   | From the server                              | To your machine                                  |
   | -------------------------------------------- | ------------------------------------------------ |
   | `projects/<project>/<id>.jsonl`              | `projects/<local project>/<id>.jsonl`            |
   | `projects/<project>/<id>/` (tool results, subagents) | `projects/<local project>/<id>/`         |
   | `file-history/<id>/` (snapshots for `/rewind`) | `file-history/<id>/`                           |

   The working directory recorded in the transcript is changed to your local project folder. Then `claude --resume <id>` runs locally in that folder.
4. **Remote** (`--remote`). A PTY sized to your terminal is opened on the server, and `cd <project-dir> && claude --resume <id>` runs through the user's login shell. Your input and output are piped through, and window resizes are forwarded.

## Troubleshooting

<details>
<summary><b>No projects folder at <code>~/.claude/projects</code></b></summary>

Claude Code is probably running under a different user on the server (for example `root`). Connect as that user, or pass the right location with `--dir`. To see which users have sessions, run this on the server:

```bash
ls -d /root/.claude /home/*/.claude 2>/dev/null
```
</details>

<details>
<summary><b><code>Claude Code is not installed on this machine</code></b></summary>

Install Claude Code locally. The session has already been copied at that point, so after installing, run the command that `claude-ssh` printed.
</details>

<details>
<summary><b><code>claude-ssh: claude not found on this server</code> (with <code>--remote</code>)</b></summary>

`claude` has to be reachable by the SSH user's login shell. Add its directory to `PATH` in `~/.profile`, `~/.bashrc` or `~/.zshrc`. Installs in `~/.local/bin`, `~/.claude/local` and `~/.nvm/versions/node/*/bin` are found automatically.
</details>

<details>
<summary><b><code>All configured authentication methods failed</code></b></summary>

The password was wrong, or the server doesn't allow password logins (`PasswordAuthentication no` in `sshd_config`). Use a key with `-i`.
</details>

<details>
<summary><b>Claude Code was suspended</b></summary>

**Ctrl+Z** suspends Claude Code. Use `/exit` to leave a session.
</details>

<details>
<summary><b>No colors in the output</b></summary>

Colors are turned off when `NO_COLOR` is set or when output isn't a terminal. 24-bit color is used when `COLORTERM=truecolor`, and 256 colors otherwise.
</details>

## Security

- Passwords are sent only to the SSH server you connect to. They are never stored or logged.
- **The server's host key is not verified yet.** Only connect to hosts on networks you trust.
- `--remote` gives you the same access as logging in with SSH as that user.
- Copied transcripts can contain anything that was in the conversation, such as file contents or command output. Treat them like the project files themselves.

## Development

```bash
git clone https://github.com/paymaan73/claude-sessions.git
cd claude-sessions
npm install
npm link            # puts `claude-ssh` on your PATH, linked to this checkout
claude-ssh --help
```

Project layout:

```text
bin/claude-ssh.js   CLI entry point: argument parsing and the overall flow
src/ssh.js          SSH connection, SFTP and the interactive remote PTY
src/copy.js         Copies a session into the local Claude Code folder
src/sessions.js     Finds and parses Claude Code session files
src/picker.js       Searchable session list prompt
src/ui.js           Colors, banner, spinner and table formatting
```

## License

MIT
