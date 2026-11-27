# Native Windows

[Português](windows.pt-br.md)

On native Windows the support is basic: the setup, the `bcct` command and the Telegram instance run from PowerShell, cmd and Git Bash, with the limits below. For everything, use WSL, where it runs as on Linux.

## 📋 Requirements

- **Node.js 24.11 or newer** on the Windows `PATH`, only for the `npx` that installs. With nvm-windows, `nvm install 24` and `nvm use 24`.
- **Git for Windows.**
- **Claude Code and Bun** on the Windows `PATH`, installed before the setup: the setup cannot install them on Windows, since their installers run through `sh`. The native Claude Code installer puts `claude.exe` in `%USERPROFILE%\.local\bin` without changing the `PATH`; add that folder to your user `PATH`.

## 📦 Installing

In PowerShell, cmd or Git Bash, `npx @pedromondek/better-claude-code-telegram` installs `bcct` and runs the setup. When you accept the setup step that puts `bcct` in the terminal (below), open a new terminal, so it sees `bcct` on the `PATH`, and use `bcct` for the rest (`bcct health`, `bcct update`).

## 🚀 Starting Claude with Telegram

| Terminal        | Command                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------- |
| PowerShell, cmd | `bcct launch`, with the same arguments as `claude --telegram` (`bcct launch --continue`) |
| Git Bash        | `claude --telegram`, through the function the setup adds to `~/.bashrc`                  |

Git Bash opens a login shell, which reads the first of `~/.bash_profile`, `~/.bash_login` and `~/.profile`. When you have none of them, Git for Windows creates a `~/.bash_profile` that loads `~/.bashrc`; when you already had one that does not load `~/.bashrc`, add `. ~/.bashrc` to it or use `bcct launch`.

The setup step that puts `bcct` in the terminal adds `%USERPROFILE%\.claude\better-claude-code-telegram\bin` to the start of your user `PATH`, in the registry (`HKCU\Environment`), and keeps the `%VAR%` entries as they are. New terminals see it; the ones already open do not. Turning the step off, uninstalling or undoing the setup takes the folder out again.

## 🚫 Not supported on native Windows

- `claude --telegram` in PowerShell and cmd: use `bcct launch`.
- Refusing a second Telegram instance: the check reads the processes with `ps`, so open only one.
- Installing a missing tool from the setup (Claude Code, Bun, uv).
- Local voice transcription.
- Running a status line you already had before ours, which goes through `sh`.
