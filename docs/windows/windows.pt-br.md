# Windows nativo

[English](windows.md)

No Windows nativo o suporte é básico: o setup, o comando `bcct` e a instância do Telegram rodam pelo PowerShell, pelo cmd e pelo Git Bash, com os limites abaixo. Para tudo, use o WSL, onde roda como no Linux.

## 📋 Requisitos

- **Node.js 24.11 ou mais novo** no `PATH` do Windows, só para o `npx` que instala. Com o nvm-windows, `nvm install 24` e `nvm use 24`.
- **Git for Windows.**
- **Claude Code e Bun** no `PATH` do Windows, instalados antes do setup: o setup não consegue instalar os dois no Windows, porque os instaladores rodam pelo `sh`. O instalador nativo do Claude Code põe o `claude.exe` em `%USERPROFILE%\.local\bin` sem mexer no `PATH`; adicione essa pasta ao `PATH` do seu usuário.

## 📦 Instalar

No PowerShell, no cmd ou no Git Bash, `npx @pedromondek/better-claude-code-telegram` instala o `bcct` e roda o setup. Quando você aceitar o passo do setup que põe o `bcct` no terminal (abaixo), abra um terminal novo, para ele enxergar o `bcct` no `PATH`, e use o `bcct` para o resto (`bcct health`, `bcct update`).

## 🚀 Abrir o Claude com o Telegram

| Terminal        | Comando                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| PowerShell, cmd | `bcct launch`, com os mesmos argumentos do `claude --telegram` (`bcct launch --continue`) |
| Git Bash        | `claude --telegram`, pela função que o setup põe no `~/.bashrc`                           |

O Git Bash abre um shell de login, que lê o primeiro que existir entre `~/.bash_profile`, `~/.bash_login` e `~/.profile`. Quando você não tem nenhum deles, o Git for Windows cria um `~/.bash_profile` que carrega o `~/.bashrc`; quando você já tinha um que não carrega o `~/.bashrc`, acrescente `. ~/.bashrc` a ele ou use o `bcct launch`.

O passo do setup que põe o `bcct` no terminal adiciona `%USERPROFILE%\.claude\better-claude-code-telegram\bin` no começo do `PATH` do seu usuário, no registro (`HKCU\Environment`), e mantém as entradas `%VAR%` como estão. Os terminais novos enxergam; os que já estavam abertos, não. Desligar o passo, desinstalar ou desfazer o setup tira a pasta de novo.

## 🚫 Sem suporte no Windows nativo

- `claude --telegram` no PowerShell e no cmd: use `bcct launch`.
- Recusar uma segunda instância do Telegram: a checagem lê os processos pelo `ps`, então abra só uma.
- Instalar pelo setup uma ferramenta que falta (Claude Code, Bun, uv).
- A transcrição local de áudio.
- Rodar a status line que você já tinha antes da nossa, que passa pelo `sh`.
