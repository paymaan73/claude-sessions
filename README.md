<div align="center">

# claude-ssh

**Resume Claude Code sessions on a remote machine, straight from your terminal.**

[![npm](https://img.shields.io/npm/v/claude-ssh-sessions?color=d97757)](https://www.npmjs.com/package/claude-ssh-sessions)
[![node](https://img.shields.io/node/v/claude-ssh-sessions?color=d97757)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-d97757)](#license)

</div>

`claude-ssh` connects to a server over SSH, lists the [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions stored there, and resumes the one you pick in a full interactive terminal. The server doesn't need anything installed besides SSH and Claude Code.

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

- **Key or password auth.** Uses your SSH agent or default key first, and asks for a password only if needed.
- **Nothing to install on the server.** Sessions are read over SFTP from `~/.claude/projects`.
- **Searchable session list.** Each session shows its title (or first prompt), project path and last activity. Type to filter.
- **Native terminal experience.** The session runs in a remote PTY with raw input and live resizing, so Claude Code behaves exactly as it does locally.
- **Finds `claude` for you.** Checks the login shell's `PATH`, then falls back to common install locations, including nvm.

## Requirements

| Machine      | Requirement                                                   |
| ------------ | ------------------------------------------------------------- |
| Local        | Node.js 18 or later                                           |
| Remote       | An SSH server, with Claude Code installed for the SSH user    |

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
3. Press **Enter**. Claude Code opens on the server in the session's project directory, with the conversation restored.
4. Exit Claude Code (`/exit`). The connection closes and you're back in your local shell.

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
| `-d, --dir <path>`      | Where to look for sessions on the server ([details](#session-lookup)) | `~/.claude/projects` |
| `-P, --project <text>`  | Open the list already filtered by project or title                 |                      |
| `-n, --limit <n>`       | Maximum number of sessions shown, newest first                     | `50`                 |
| `-h, --help`            | Show help                                                          |                      |
| `-- <args>`             | Everything after `--` is passed to `claude` on the server          |                      |

### Examples

```bash
# Pick from every session on the server
claude-ssh dev@devbox.example.com

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
3. **Resume.** A PTY sized to your terminal is opened on the server, and this runs through the user's login shell:
   ```sh
   cd <project-dir> && claude --resume <session-id>
   ```
4. **Attach.** Your keyboard input goes to the remote PTY and its output comes back to your terminal. Window resizes are forwarded.

## Troubleshooting

<details>
<summary><b>No projects folder at <code>~/.claude/projects</code></b></summary>

Claude Code is probably running under a different user on the server (for example `root`). Connect as that user, or pass the right location with `--dir`. To see which users have sessions, run this on the server:

```bash
ls -d /root/.claude /home/*/.claude 2>/dev/null
```
</details>

<details>
<summary><b><code>claude-ssh: claude not found on this server</code></b></summary>

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
- Resuming a session gives you the same access as logging in with SSH as that user.

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
src/sessions.js     Finds and parses Claude Code session files
src/picker.js       Searchable session list prompt
src/ui.js           Colors, banner, spinner and table formatting
```

## License

MIT
