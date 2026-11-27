# 001. AskUserQuestion respondido pelo Telegram via hook PermissionRequest

> **Versão:** 2 · **Decidido por:** pedromondek
> **Criado em:** 2026-10-19 01:16 · **Atualizado em:** 2026-11-15 20:22
> **Âncoras:** `rust/crates/bcct/src/hook.rs` (`permission`, `wait_for_answer`, `decision_output`) · `plugins/telegram-hooks/hooks/hooks.json` (`PermissionRequest`) · `plugins/telegram/extensions/ask-mirror.ts` (`ANSWER_SUFFIX`)

**Decisão:** em toda instância da máquina, enquanto o bot está de pé, o hook `PermissionRequest` com matcher `AskUserQuestion` do plugin `telegram-hooks` (o binário, `bcct hook permission`, em `rust/crates/bcct/src/hook.rs`, tempo-limite de 86400 s) grava a pergunta, espera o arquivo de resposta que o canal grava (`ANSWER_SUFFIX`, lido em `wait_for_answer`) e devolve `allow` com `updatedInput.answers` (`decision_output`). A pergunta continua aberta no terminal durante a espera: a resposta dada no terminal vale primeiro, e o hook sai ao ver o pedido fechado pelo `PostToolUse`.

**Porquê:** medido em sessão interativa, inclusive no modo automático: o `PermissionRequest` dispara junto com a pergunta já visível no terminal, a resposta que ele devolve fecha a pergunta como respondida no mesmo formato do terminal (o rótulo, ou os rótulos separados por vírgula na escolha múltipla) e a resposta atrasada é ignorada quando o terminal responde antes. O hook não é encerrado quando o terminal responde, por isso ele mesmo sai. É o único caminho medido que mantém a pergunta no terminal primeiro sem simular tecla, e funciona em qualquer terminal.

**Descartado:** Esc por TIOCSTI — exige `dev.tty.legacy_tiocsti=1` no kernel inteiro, e um processo sem root só injeta tecla no próprio terminal. Esc pelo tmux — prende a instância ao tmux, e a pergunta volta como recusada, com a resposta chegando por outro canal. Hook `PreToolUse` com `updatedInput` — roda antes de a pergunta aparecer e a esconde do terminal enquanto espera. Elicitação MCP com cancelamento — o fechamento da tela no cancelamento não é documentado, e troca a tela do `AskUserQuestion` por outra.
