# 010. A primeira versão de cada pacote npm sai pelo login do mantenedor

> **Versão:** 1 · **Decidido por:** pedromondek
> **Card:** [#20](https://github.com/pedromondek/better-claude-code-telegram/issues/20)
> **Branch:** `0020-staging-on-npm-fails-when-the-version-is`
> **Criado em:** 2026-11-26 11:34 · **Atualizado em:** —
> **Âncoras:** `scripts/release-npm-publish.mjs` (`createNpm`, `published`, `stagePublish`, `trust`) · `.github/workflows/release.yml` (job `npm`)

**Decisão:** a primeira versão de cada um dos 7 pacotes npm (o principal e os 6 de plataforma) é posta em stage pelo login do mantenedor, na dist-tag do estágio, e aprovada no npmjs.com. Em seguida, `npm run release:npm:publish -- trust` roda no terminal, onde o npm pede a senha de uso único da conta, e a `latest` sai do esboço `0.0.0-stage` que o staging de um pacote novo cria, por `npm dist-tag`. Da versão seguinte em diante, o job `npm` do `release.yml` publica por trusted publishing.

**Porquê:** o `npm trust github` exige o pacote já existente no registry, e o npm não tem equivalente ao "pending publisher" do PyPI. O staging por OIDC precisa do trusted publisher configurado, então a primeira versão nunca sai pelo pipeline sozinha.

**Descartado:** um token granular só na primeira versão, no CI, com `--provenance` (daria proveniência à primeira versão, mas exige mexer no job de stage e manter um segredo temporário no environment).
