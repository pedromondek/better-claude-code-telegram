# 001. Atraso por tipo, com o atraso único como padrão

> **Versão:** 2 · **Decidido por:** pedromondek
> **Criado em:** 2026-11-15 20:18 · **Atualizado em:** 2026-11-23 21:00
> **Âncoras:** `plugins/telegram/extensions/config.ts` (`DELAY_KINDS`, `DEFAULT_REMINDER_MINUTES`, `readDelayMinutes`, `formatDelay`) · `rust/crates/bcct/src/config.rs` (`DelayKind`, `delay_ms_for`) · `rust/crates/bcct/src/setup_ask.rs` (`ask_delay`, `ask_delay_kinds`, `single_delay`) · `rust/crates/bcct/src/install.rs` (`Kept::Delays`) · `plugins/telegram/extensions/__tests__/fixtures/delays.json`

**Decisão:** o atraso até ir ao Telegram é por tipo: `delays.questions`, `delays.permissions` e `delays.waiting`, em minutos, com 0 = na hora e `delayMinutes` como valor do tipo ausente. O canal lê em `readDelayMinutes` (`config.ts`) e o binário em `delay_ms_for` (`config.rs`), com o formato travado pelo mesmo `delays.json` dos dois lados. O tipo `reminder` ([005](005-lembrete-do-multiselect.md)) fica fora: sem valor, usa os 3 min dele (`DEFAULT_REMINDER_MINUTES`), nunca o `delayMinutes`, e o atraso único não o muda. No setup, "Por tipo…" é uma opção da lista do atraso (`ask_delay`), com os tipos ao lado como dica; só quem a escolhe vê as três perguntas (`ask_delay_kinds`). Três tipos iguais são gravados como o atraso único (`single_delay`), e gravar os mesmos valores responde "mantido" (`Kept::Delays`). O tempo aparece em segundos abaixo de 1 min e em minutos e segundos acima ("2 min 30 s", `formatDelay`).

**Porquê:** pergunta pede resposta rápida, e o aviso de espera pode esperar mais; um atraso só obrigava a escolher entre perguntas demoradas e avisos cedo demais. A opção na lista não acrescenta pergunta a quem quer um atraso só. O contrato num fixture comum impede que o canal e o hook leiam o mesmo arquivo de jeitos diferentes.

**Descartado:** chave só para perguntas — deixa as permissões e o aviso presos ao mesmo valor. Chave compartilhada por perguntas e permissões — o mesmo problema, um passo depois. Pergunta s/n "ajustar por tipo?" em todo setup — uma pergunta a mais para todo mundo. As três perguntas sempre — três perguntas para quem quer um valor só.
