# 002. Node só para o npx que instala

> **Versão:** 2 · **Decidido por:** pedromondek
> **Card:** [#1](https://github.com/pedromondek/better-claude-code-telegram/issues/1)
> **Branch:** `0001-base-of-the-project-up-to-the-first-alpha` · **PR:** [#2](https://github.com/pedromondek/better-claude-code-telegram/pull/2)
> **Criado em:** 2026-11-20 02:52 · **Atualizado em:** 2026-11-23 10:32
> **Âncoras:** `rust/crates/bcct/src/setup_run.rs` · `rust/crates/bcct/src/health.rs` (`Group::Install`) · `plugins/telegram/.mcp.json` · `npm/shim/`

**Decisão:** o Node não é requisito do `bcct` instalado. O setup (`setup_run.rs`) não checa o Node, e o `bcct health` não tem checagem de Node no grupo Install (`Group::Install`). O Node 24.11 ou mais novo só é preciso para o `npx` que instala (`npm/shim/`).

**Porquê:** depois da instalação, nada roda no Node. O canal roda com bun (`plugins/telegram/.mcp.json`), e os hooks e a statusline são o binário `bcct`. O Node só serve ao `npx` que instala.

**Descartado:** exigir o Node no setup — barra a instalação por algo que nada usa. Mostrar o Node no health como informativo — mostra o que nada usa. Manter o setup barrando só o Node velho e aceitando a falta, com o health falhando sem Node — incoerente.
