# 001. Voltar nas perguntas que uma opção abre

> **Versão:** 1 · **Decidido por:** pedromondek
> **Criado em:** 2026-11-15 20:18 · **Atualizado em:** —
> **Âncoras:** `rust/crates/bcct/src/prompt/ask.rs` (`with_back`, `ask_choice_then`, `back_prompt`) · `rust/crates/bcct/src/prompt.rs` (`PromptError::Back`, `Prompter::set_back`) · `rust/crates/bcct/src/prompt/guard.rs` (`GuardCancel`) · `rust/crates/bcct/src/prompt/line.rs` (`LineKey::Back`) · `rust/crates/bcct/src/prompt/select.rs` (`SelectKey::Back`) · `rust/crates/bcct/src/setup_ask.rs` (`ask_delay_kinds`, `ask_transcription`)

**Decisão:** no setup do terminal, toda pergunta que uma opção abre aceita voltar: Esc, ou seta esquerda (na linha digitada, só com o cursor no começo), volta à lista com o cursor na opção de onde veio, sem gravar nada, e a seta direita confirma na lista como o Enter. A peça é comum, em `prompt/ask.rs`: `with_back` liga o modo só durante a pergunta aberta, `ask_choice_then` reabre a lista quando ela volta (`PromptError::Back`), `back_prompt` põe a dica na linha, e numa lista aberta por opção (como a de apagar modelos do "Desinstalar" da transcrição) entra o item "← Voltar". No "Por tipo…" a volta é um passo por vez (`ask_delay_kinds`). O `GuardCancel` repassa o modo e o desliga na pergunta de sair do Ctrl+C. Sem terminal, com a entrada por pipe, não há voltar.

**Porquê:** sem voltar, quem entrava em "Customizado" ou "Por tipo…" por engano só saía pelo Ctrl+C, que encerra o setup inteiro. Na peça comum, toda pergunta nova aberta por opção ganha o voltar sem código próprio.

**Descartado:** só o Esc, sem item na lista — numa lista o item visível diz que dá para voltar. Digitar "voltar" — vira um valor reservado dentro do texto livre. "← Voltar" entre as etapas do setup — perguntaria de novo etapas que já gravaram arquivo. Esc no "Por tipo…" direto para a lista — perde o que foi digitado nos tipos anteriores. Mostrar o valor já digitado ao voltar — o Enter já o mantém.
