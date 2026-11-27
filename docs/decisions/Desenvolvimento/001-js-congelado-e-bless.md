# 001. JS removido e fixtures regravados pelo binário

> **Versão:** 2 · **Decidido por:** pedromondek
> **Card:** [#3](https://github.com/pedromondek/better-claude-code-telegram/issues/3)
> **Branch:** `0003-remove-the-frozen-javascript-setup-and`
> **Criado em:** 2026-11-15 20:18 · **Atualizado em:** 2026-11-23 10:32
> **Âncoras:** `package.json` (`rust:bless`) · `rust/crates/bcct/tests/` (`blessing_*` em `setup_run.rs`, `hook.rs`, `health.rs`, `setup_terminal.rs`, `setup_terminal_pty.rs`) · `rust/crates/bcct/tests/support/mod.rs` (`CLONE_STATUSLINE`, `CLONE_SHELL_FILE`)

**Decisão:** o binário `bcct` é a única implementação dos hooks, do setup, do health, do launcher e da status line. O repositório não guarda o JS que ele substituiu nem o layout do clone, e o binário não reconhece mais a linha do rc nem a status line do clone. Os fixtures de `rust/crates/bcct/tests/fixtures/` são arquivos estáticos. Os que têm teste `blessing_*` são regravados pelo próprio binário com `npm run rust:bless`, que roda esses testes um por vez (mais de um grava o mesmo arquivo) e passa o prettier nos fixtures; os outros mudam à mão. Cada mudança de fixture é revisada no diff antes de entrar. O `tests/support/mod.rs` continua traduzindo o layout do clone gravado neles para o do binário.

**Porquê:** o binário se provou na alpha, e ninguém usa o clone fora de quem desenvolve. Manter o JS custava testes, mutação e revisão de um código que não roda. O bless grava o que o binário de fato imprime, sem erro nos bytes do terminal (posição do cursor, quebra de linha).

**Descartado:** manter o JS congelado como reserva, sem receber mudança — código sem uso pagando o gate. Manter o JS em paridade com o binário — trabalho dobrado em cada mudança. Manter no binário a migração do layout do clone — só quem desenvolve o tinha, e ele se conserta com `bcct uninstall` e `bcct setup`. Manter o launcher do clone apontando só para o binário — o `npm run dev:install` já põe o binário da árvore no lugar. Regravar pelo binário os fixtures sem bless — eles gravam o setup e o launcher num ambiente que o teste só reproduz com o texto traduzido. Editar à mão os fixtures que têm bless — erro fácil e lento nos bytes do terminal.
