# 002. Valor digitado igual a uma opção vale como a opção

> **Versão:** 1 · **Decidido por:** pedromondek
> **Criado em:** 2026-11-15 20:18 · **Atualizado em:** —
> **Âncoras:** `rust/crates/bcct/src/prompt/ask.rs` (`with_own`, `Own`, `number_choices`) · `rust/crates/bcct/src/setup_ask.rs` (`ask_quiet_hours`, `single_delay`)

**Decisão:** em toda pergunta do setup com "Customizado", o valor salvo só vira item próprio da lista quando nenhuma opção tem esse valor; se alguma tem, é ela que aparece marcada como escolha anterior, sem repetir. A peça é `with_own` (com `Own`, em `prompt/ask.rs`), usada pelo `number_choices` (atraso e inbox) e pelo horário de silêncio (`ask_quiet_hours`); a comparação vem de quem chama, e o número usa a igualdade do `includes` do JS. Valor composto tem forma canônica: três tipos iguais são o atraso único (`single_delay`).

**Porquê:** digitar "4" num setup que já oferece "4 min" criava dois itens iguais, e na volta seguinte o atual aparecia como opção à parte. Cada pergunta resolvendo o próprio caso deixava casos de fora, como o atraso por tipo; com a peça comum, a pergunta nova herda o comportamento.

**Descartado:** um filtro próprio em cada pergunta — cada uma resolve só a sua particularidade e a próxima esquece. Listar o valor digitado como item à parte mesmo igual a uma opção — a mesma escolha aparece duas vezes.
