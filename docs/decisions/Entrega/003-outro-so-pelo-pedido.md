# 003. No Telegram, o texto do Outro só vale em resposta ao pedido do botão

> **Versão:** 1 · **Decidido por:** pedromondek
> **Criado em:** 2026-11-15 20:18 · **Atualizado em:** —
> **Âncoras:** `plugins/telegram/extensions/ask-mirror.ts` (`consumeText`, `answerTyped`, `noticeNeedsPrompt`) · `plugins/telegram/extensions/ask-format.ts` (`typeSelection`, `progressKeyboard`, `progressAnswer`) · `plugins/telegram/extensions/i18n.ts` (`writeOtherAnswer`, `otherNeedsPrompt`, `otherHint`)

**Decisão:** o texto digitado só vira resposta quando cita o pedido que o botão "Outro" abre (o force reply registrado em `otherPrompts`; `consumeText` em `ask-mirror.ts`). Texto solto, ou citando a mensagem da pergunta, segue ao Claude como mensagem normal, e o bot diz como responder (`otherNeedsPrompt`): uma vez para o texto solto com um "Outro" aberto, toda vez para quem cita a pergunta. Na escolha múltipla o texto vira mais uma marcação (`typeSelection`, mostrado no botão do "Outro" por `progressKeyboard`), a pergunta fica aberta até "Concluir" (`progressAnswer`), e um novo "Outro" troca o texto, com o pedido avisando o que será substituído (`writeOtherAnswer`). Na escolha única o texto responde na hora.

**Porquê:** sem a citação do pedido não há como separar uma resposta de uma conversa com o Claude, e tomar o texto solto como resposta engolia mensagens que eram para ele. Na múltipla, fechar no primeiro texto impedia marcar mais opções. O aviso no pedido deixa claro, antes de mandar, que o texto novo substitui o anterior.

**Descartado:** tomar o texto solto como resposta da pergunta mais recente, com aviso de qual levou — engole a conversa com o Claude. Aceitar a citação da mensagem da pergunta — não distingue de um comentário sobre ela. Reter o texto solto sem mandá-lo ao Claude — a mensagem se perderia. Confirmação depois da troca — o aviso no pedido já diz antes. O texto da múltipla concluir a pergunta — impede marcar mais.
