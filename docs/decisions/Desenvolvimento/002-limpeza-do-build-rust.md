# 002. Build Rust apaga só o build velho

> **Versão:** 1 · **Decidido por:** pedromondek
> **Criado em:** 2026-11-15 20:18 · **Atualizado em:** —
> **Âncoras:** `package.json` (`rust:build`, `rust:cov`, `rust:clean`) · `.husky/__tests__/lint-staged-tooling.test.mjs`

**Decisão:** `npm run rust:build` apaga o build de release anterior antes de compilar (`cargo clean --release`), `npm run rust:cov` apaga a cobertura anterior antes (`cargo llvm-cov clean --workspace`), e upgrade de dependência roda `npm run rust:clean` no mesmo commit. O build incremental dos testes fica. O `CARGO_TARGET_DIR` escolhe onde o build vai, e o pre-push e o `check:commit` o respeitam.

**Porquê:** o release não tem cache incremental, então o anterior é só peso, e o build de cobertura acumulava gigabytes a cada rodada; o incremental dos testes é o que deixa o ciclo de edição rápido. As versões velhas de dependência só saem do build de teste com o clean.

**Descartado:** `cargo clean` inteiro antes de cada build — perde o incremental dos testes e deixa todo ciclo lento. Nunca limpar — o disco enche com builds que não servem mais.
