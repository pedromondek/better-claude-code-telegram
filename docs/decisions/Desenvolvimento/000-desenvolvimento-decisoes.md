# Desenvolvimento — Decisões

## Resumo

Fonte **canônica** das decisões de desenvolvimento do repositório: ferramentas, testes e build de quem contribui. Cada arquivo descreve a decisão **no estado atual** — o que foi decidido, por quê e o que foi descartado — sem histórico cronológico.

Convenção: **um arquivo por decisão** (`NNN-slug.md`), no formato **Decisão · Porquê · Descartado**. Este arquivo (`000`) é o índice.

## Decisões

| #                                              | Decisão                                                                                     | Versão | Por         | Criado           | Atualizado       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ | ----------- | ---------------- | ---------------- |
| [001](001-js-congelado-e-bless.md)             | JS removido e fixtures regravados pelo binário                                              | 2      | pedromondek | 2026-11-15 20:18 | 2026-11-23 10:32 |
| [002](002-limpeza-do-build-rust.md)            | Build Rust apaga só o build velho                                                           | 1      | pedromondek | 2026-11-15 20:18 | —                |
| [003](003-instalacao-local-para-teste.md)      | Instalação local para o teste ao vivo                                                       | 1      | pedromondek | 2026-11-15 20:18 | —                |
| [004](004-revisao-de-codigo-local.md)          | Revisão de código local, com o gate da PR versionado                                        | 2      | pedromondek | 2026-11-18 21:29 | 2026-11-20 02:51 |
| [005](005-mutacao-no-ci.md)                    | Mutação no CI da PR, em shards, com os mutantes já pegos                                    | 1      | pedromondek | 2026-11-20 02:52 | —                |
| [006](006-patch-notes-em-toda-pr.md)           | Patch notes em toda PR, na descrição, um bloco recolhido por idioma                         | 2      | pedromondek | 2026-11-24 14:29 | 2026-11-24 19:46 |
| [007](007-ci-passed-le-os-jobs-do-run.md)      | O CI passed também lê os jobs do run pela API                                               | 2      | pedromondek | 2026-11-24 14:29 | 2026-11-27 01:09 |
| [008](008-anuncio-das-releases-no-telegram.md) | Cada release é anunciada em quatro canais do Telegram, sem repetir                          | 3      | pedromondek | 2026-11-25 18:51 | 2026-11-26 22:39 |
| [009](009-release-no-push-da-main.md)          | O release roda no push da main e acha a PR de versão pelo título do merge                   | 1      | pedromondek | 2026-11-26 11:34 | —                |
| [010](010-primeira-versao-no-npm.md)           | A primeira versão de cada pacote npm sai pelo login do mantenedor                           | 1      | pedromondek | 2026-11-26 11:34 | —                |
| [011](011-instalacao-na-release.md)            | Toda Release diz como instalar e atualizar a versão, em alertas gerados pela versão         | 1      | pedromondek | 2026-11-26 22:34 | —                |
| [012](012-fixar-a-abertura-no-telegram.md)     | O anúncio fixa a abertura de cada versão e desafixa a anterior                              | 1      | pedromondek | 2026-11-26 22:34 | —                |
| [013](013-latest-do-npm.md)                    | A latest do npm acompanha a pré-versão até a primeira estável, movida pelo release por OIDC | 2      | pedromondek | 2026-11-27 00:39 | 2026-11-27 01:09 |
| [014](014-doc-de-funcionalidades.md)           | A doc de funcionalidades é gerada dos itens ✨ das releases, no commit de registro          | 1      | pedromondek | 2026-11-27 01:55 | —                |
