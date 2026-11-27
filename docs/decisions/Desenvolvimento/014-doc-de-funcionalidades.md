# 014. A doc de funcionalidades é gerada dos itens ✨ das releases, no commit de registro

> **Versão:** 1 · **Decidido por:** pedromondek
> **Card:** [#24](https://github.com/pedromondek/better-claude-code-telegram/issues/24)
> **Branch:** `0024-move-the-npm-latest-tag-to-each-pre`
> **Criado em:** 2026-11-27 01:55 · **Atualizado em:** —
> **Âncoras:** `scripts/features-doc.mjs` (`buildFeaturesDocs`, `releaseNotes`, `featuresFiles`, `FEATURES_DOCS`) · `scripts/release-publish.mjs` (`record`) · `scripts/release-pr.mjs` (`notesProblem`) · `.prettierignore` · `_typos.toml`

**Decisão:** `docs/features/features.md` e `docs/features/features.pt-br.md` são gerados pelo `npm run docs:features` (`scripts/features-doc.mjs`) a partir dos itens ✨ de `docs/releases/<x.y.z>/<estágio>.md`, por área e na ordem das versões: um item posterior com o mesmo título substitui o anterior, e um 🔥 com o título o remove. O GIF de cada item vira um link `▶ Demo` (`▶ Demonstração` no pt-br), sem mídia aberta na página. O passo `record` do release grava a doc no mesmo commit do App que grava o `checksums.txt` e as notas. Um teste exige que o arquivo do repositório seja igual ao gerado, e o `check-notes` recusa notas sem o bloco pt-br, de que o gerador precisa. O README só linka a doc, e `docs/features/` fica fora do prettier e do typos, como `docs/releases/`.

**Porquê:** a lista completa das funcionalidades fica num lugar só, sem o README crescer sem fim, e não envelhece: o texto de cada item já é escrito e aprovado a cada versão, nas notas da Release. Os GIFs abertos somavam cerca de 7,4 MB numa página só e cresceriam a cada versão. As notas só viram arquivo no commit de registro, depois do merge da PR de versão, então só ali a doc anda junto com elas; sem o bloco pt-br o gerador falha, e o `check-notes` barra isso antes do merge e do build.

**Descartado:** doc curada à mão a partir dos itens, com um teste só de títulos (dois textos para manter); uma doc por funcionalidade com um índice (mais arquivos para manter); tudo no README (vira um bloco gigante com o tempo); só linkar o how-it-works, sem trava (a lista envelhece sem ninguém notar); sem teste, só por regra e revisão; cópia à mão na PR de versão (as notas só chegam a `docs/releases` no merge, e a `main` ficaria vermelha depois de cada release); GIFs abertos ou recolhidos na página (pesa com o tempo); link para o MP4 (só fica público quando a #26 publicar as mídias).
