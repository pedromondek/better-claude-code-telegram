# 003. Instalação local para o teste ao vivo

> **Versão:** 1 · **Decidido por:** pedromondek
> **Criado em:** 2026-11-15 20:18 · **Atualizado em:** —
> **Âncoras:** `scripts/dev-install.mjs` (`devBinary`, `devPlugins`, `runDev`, `LAUNCHER_ONLY_PLUGIN`) · `package.json` (`dev:binary`, `dev:plugins`, `dev:install`) · `scripts/__tests__/dev-install.test.mjs`

**Decisão:** o teste ao vivo usa três comandos de `scripts/dev-install.mjs`. `npm run dev:binary` compila o release (sob `systemd-run --user` com teto de memória, `BCCT_BUILD_MEMORY` 5G e `CARGO_BUILD_JOBS` 3 por padrão, quando ele consegue subir uma unit do usuário; direto fora disso, respeitando o `CARGO_TARGET_DIR`) e o instala com `bcct self-install` e o sha256. `npm run dev:plugins` desinstala e instala de novo os plugins do marketplace e desliga outra vez o `telegram@` (`LAUNCHER_ONLY_PLUGIN`). `npm run dev:install` roda os dois, os plugins só depois do binário. No fim, ele avisa que mudança no servidor do canal só vale depois do `/mcp reconnect plugin:telegram:telegram` ou de reabrir o `claude --telegram`.

**Porquê:** o Claude Code roda o plugin da cópia em cache por versão, e a mesma versão não se atualiza; o `telegram@` precisa ficar desligado no usuário, porque só o launcher o liga; o cargo sem teto abre um rustc por núcleo e esgota a memória; e o `/reload-plugins` recarrega hooks e skills mas não reinicia o servidor do canal (medido: o pid continua o mesmo).

**Descartado:** um comando só, sem os passos soltos — refaz o que não mudou. Deixar o teto de memória para quem chama — o comando fácil voltaria a precisar do prefixo longo. `claude plugin update` — não atualiza a mesma versão.
