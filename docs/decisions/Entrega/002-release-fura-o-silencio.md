# 002. /bcct:release fura o horário de silêncio, com aviso no início e resumo no fim

> **Versão:** 2 · **Decidido por:** pedromondek
> **Criado em:** 2026-11-15 20:18 · **Atualizado em:** 2026-11-27 02:56
> **Âncoras:** `rust/crates/bcct/src/release.rs` (`RELEASED`, `release_pending_notices`) · `plugins/telegram/extensions/ask-mirror.ts` (`held`) · `plugins/telegram/extensions/waiting-ping.ts` (`tick`) · `plugins/telegram/extensions/permission-delay.ts` · `plugins/telegram/extensions/quiet-notice.ts` (`QUIET_NOTICE_FILE`, `createQuietNotice`) · `plugins/bcct/skills/release/SKILL.md`

**Decisão:** as perguntas liberadas pelo `/bcct:release` vão ao Telegram na hora, mesmo dentro do horário de silêncio: o `release` do binário (`release.rs`, campo `released`) marca a pergunta, e o espelho (`held` e o envio em `ask-mirror.ts`) honra `released === true` acima do silêncio. O `release` também solta os avisos de espera e de falha da sessão (`release_pending_notices` em `release.rs`, o mesmo campo `released`), e o `tick` de `waiting-ping.ts` os envia mesmo dentro do silêncio; só os pedidos de permissão continuam retidos (`permission-delay.ts`). Quando o silêncio começa, o canal manda um aviso único por período, com o fim, como desligar e o `/bcct:release`; quando acaba, um resumo do que ficou retido vem antes dos itens (`createQuietNotice` em `quiet-notice.ts`, estado em `QUIET_NOTICE_FILE`). Sem nada retido, não há resumo.

**Porquê:** o release é um pedido explícito do usuário, e segurar a pergunta que ele acabou de pedir anula o comando: o release só antecipava o prazo, e dentro do silêncio não mandava nada. O aviso no início evita que o silêncio pareça o bot fora do ar, e o resumo diz o que chega junto quando ele acaba.

**Descartado:** o silêncio sempre vence, com uma mensagem "sai às 07:00" — o release deixaria de valer justo quando é pedido. Aviso só no início, sem resumo — os itens retidos chegariam soltos, sem dizer quantos nem por quê.
