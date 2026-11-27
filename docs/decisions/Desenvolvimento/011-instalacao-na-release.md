# 011. Toda Release diz como instalar e atualizar a versão, em alertas gerados pela versão

> **Versão:** 1 · **Decidido por:** pedromondek
> **Card:** [#27](https://github.com/pedromondek/better-claude-code-telegram/issues/27)
> **Branch:** `0027-releases-show-how-to-install-and-update`
> **Criado em:** 2026-11-26 22:34 · **Atualizado em:** —
> **Âncoras:** `scripts/release-notes-layout.mjs` (`installAlert`, `updateAlert`, `notesSkeleton`) · `scripts/release-npm-publish.mjs` (`installCommand`) · `scripts/release-announce.mjs` (`openingText`) · `npm/shim/shim.mjs` (`TOP_LEVEL_COMMANDS`) · `scripts/release-pr.mjs` (`notesProblem`)

**Decisão:** toda Release leva dois alertas `> [!IMPORTANT]` entre o TIP dos canais e o NOTE da legenda, nos dois idiomas e fora dos blocos recolhidos, que o `notesSkeleton` escreve. O primeiro, do `installAlert(version)`, traz o comando de instalação (`installCommand`: `npx @pedromondek/better-claude-code-telegram@<tag do estágio>` numa pre-release, sem tag na estável), o comando da versão exata e o `claude --telegram`. O segundo, do `updateAlert(version)`, traz as três formas de atualizar, uma ou outra: `bcct update`, o mesmo `npx` com `update` (o shim repassa `update` ao binário) e `/bcct:update`. Cada comando fica no seu bloco de código. A abertura do anúncio no Telegram usa o mesmo `installCommand`. O `notesProblem` ignora as linhas de alerta ao decidir se as notas estão vazias.

**Porquê:** a Release não dizia como instalar nem atualizar a versão, e o resumo escrito à mão da 0.1.0-alpha.2 saiu sem a tag, o que instalaria a `latest` (a alpha.1). Quem não pôs o `bcct` no PATH não tinha um comando de atualização pelo terminal. Gerado pela versão, ninguém erra a tag. O botão de copiar do GitHub só existe num bloco de código e copia só a linha dele.

**Descartado:** instalar e atualizar no mesmo alerta (parece uma sequência de passos, e não caminhos separados); juntar a instalação ao TIP (um alerta com dois assuntos); uma seção dentro de cada idioma (some do topo, só aparece abrindo o bloco); só o `bcct update` para atualizar (deixa de fora quem roda o bcct só pelo `npx`); `@latest` na estável (sem tag o npm já instala a `latest`, como o README faz); os comandos em código inline (sem botão de copiar).
