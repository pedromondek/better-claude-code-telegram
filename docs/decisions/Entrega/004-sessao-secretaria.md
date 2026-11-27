# 004. Recomendar uma sessão só para o Telegram, a secretária

> **Versão:** 2 · **Decidido por:** pedromondek
> **Criado em:** 2026-11-16 15:07 · **Atualizado em:** 2026-11-27 01:09
> **Âncoras:** `docs/secretary/` · `rust/crates/bcct/src/setup_run.rs` (`secretary_tip`) · `rust/crates/bcct/src/package.rs` (`repository_url!`) · `plugins/telegram/skills/channel-guide/reference/secretary.md`

**Decisão:** o projeto recomenda abrir uma sessão do Claude Code só para o Telegram (`claude --telegram`), a secretária, ou abrir com o canal a sessão orquestradora quando já existe uma. A recomendação está em três lugares: a doc `docs/secretary/` (en-us e pt-br), a dica no fim do setup completo (`secretary_tip`, com o link montado pela macro `repository_url!`) e o `reference/secretary.md` da skill `telegram:channel-guide`, que diz à secretária o que ela faz (repassa, encaminha respostas, pede andamento) e o que não faz (não edita o repositório, não decide pelo usuário, não repassa a workers de outros plugins).

**Porquê:** uma sessão no meio de uma edição só responde quando para, então a mensagem ao usuário espera atrás do código; a secretária responde na hora, e as outras sessões têm um lugar só para reportar. O usuário lê a doc e a dica; o Claude que faz de secretária lê a skill.

**Descartado:** só uma seção no README — quem não lê o README perde a recomendação, e o Claude não a recebe. Só na skill — o usuário nunca fica sabendo que vale abrir a sessão.
