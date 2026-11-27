# 009. O release roda no push da main e acha a PR de versão pelo título do merge

> **Versão:** 1 · **Decidido por:** pedromondek
> **Card:** [#19](https://github.com/pedromondek/better-claude-code-telegram/issues/19)
> **Branch:** `0020-staging-on-npm-fails-when-the-version-is`
> **Criado em:** 2026-11-26 11:34 · **Atualizado em:** —
> **Âncoras:** `.github/workflows/release.yml` (`on`, `concurrency`, `jobs.plan.if`, passo `plan`, `jobs.build.if`) · `scripts/merged-pr.mjs` (`MERGE_SUBJECT`, `parseMerges`, `mergedPrTarget`) · `.github/__tests__/workflows/release.test.mjs`

**Decisão:** o `release.yml` roda em `push` na `main` e por `workflow_dispatch` numa PR de versão mergeada. No push, o plan só segue quando o `merged-pr` acha o commit empurrado no histórico da `main` e a branch lida do título padrão do merge (`Merge pull request #N from <owner>/release/v<versão>`) começa com `release/v` (saída `release=true`). Qualquer outro push, como um merge comum, o commit de registro ou o revert de uma versão, termina verde com os jobs pulados. A PR de versão é mergeada com o título padrão, que o filtro do push e o `merged-pr` leem. A `concurrency` não cancela o release em curso.

**Porquê:** a deployment branch policy compara só o `GITHUB_REF` do run. No `pull_request` ele é `refs/pull/N/merge`, e os environments `release` e `telegram-announce` só aceitam a `main`, então o merge da PR de versão era recusado antes de publicar. No `push` e no `workflow_dispatch` o ref é `refs/heads/main`. O exemplo oficial do GitHub de deploy ao mergear usa `on: push` na `main` com environment e `concurrency`.

**Descartado:** um job no `pull_request` fechado que dispara o `workflow_dispatch` na `main` (menor mudança, mas depende de o `GITHUB_TOKEN` com `actions: write` bastar para o disparo, o que a doc não confirma, e foge do exemplo oficial); liberar `refs/pull/*/merge` no environment (quebra a regra de só publicar da `main`); achar a PR pela API `commits/{sha}/pulls` (independe do título, mas faria o plan rodar em todo push; o título padrão ficou como exigência documentada).
