# 007. O CI passed também lê os jobs do run pela API

> **Versão:** 2 · **Decidido por:** pedromondek
> **Card:** [#6](https://github.com/pedromondek/better-claude-code-telegram/issues/6)
> **Branch:** `0005-carry-patch-notes-in-every-pull-request`
> **Criado em:** 2026-11-24 14:29 · **Atualizado em:** 2026-11-27 01:09
> **Âncoras:** `.github/workflows/ci.yml` (job `ci-passed`) · `scripts/ci-passed.mjs` (`gotNoRunner`) · `scripts/ci.constants.mjs` (`CI_PASSED_JOB`, `FAILED_CONCLUSIONS`, `NO_RUNNER_CONCLUSION`, `NO_RUNNER_ANNOTATION_LEVEL`, `NO_RUNNER_ANNOTATION_MESSAGE`, `NO_RUNNER_WARNING`)

**Decisão:** o agregador `CI passed` do `ci.yml` mantém o check de `needs.*.result` e também roda o `npm run ci:passed` (`scripts/ci-passed.mjs`, com `actions: read`). O script lê `actions/runs/$RUN_ID/jobs?filter=latest`, com paginação, e falha em qualquer job do run, fora ele mesmo, que tenha terminado com `failure`, `cancelled` ou `timed_out`, exceto o job cancelado sem nenhum passo, com `runner_id` 0 e a anotação de nível `failure` "The job was not acquired by Runner" (`gotNoRunner`), que só deixa um `::warning::`, porque o GitHub o cancelou sem rodar; sem conseguir ler as anotações, ele reprova. Ele se reconhece pelo nome exato, `CI passed`. Job ainda na fila ou rodando é ignorado. O script só importa módulos nativos do Node, então roda sem `npm ci`.

**Porquê:** na `main` em `45eb955` (run 45423614888, tentativa 1), o job do Rust no macOS-15 foi cancelado por falta de runner, e mesmo assim o `CI passed` ficou verde. O defeito é o repasse: o job que chama o `check-rust-platforms.yml`, uma matriz, entregou `needs.rust.result = success`. O GitHub não documenta como os jobs de um workflow chamado sobem para o resultado de quem chama, e o mesmo comportamento está em `actions/runner#3041`, fechado como "not planned". O `CI passed` é o único check obrigatório da `main`. A exceção existe porque o GitHub cancela sem rodar o job que nenhum runner pega, e isso não é falha do código; ela vale só com os três sinais juntos (sem passo, `runner_id` 0 e a anotação), para um cancelamento de verdade continuar reprovando.

**Descartado:** um job de fechamento dentro do `check-rust-platforms.yml` — cobre só essa task e depende do mesmo repasse não documentado. Separar a matriz em dois jobs comuns — o repasse também não é documentado. Contar só os jobs das tasks do `needs` — um job fora dele que terminasse falhando passaria. Reprovar todo `cancelled`, sem exceção — o job que o GitHub cancela por falta de runner deixaria o `CI passed` vermelho sem nada a corrigir no código.
