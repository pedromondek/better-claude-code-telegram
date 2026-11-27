# Uma sessão para o Telegram

[English](secretary.md)

Toda instância do Claude Code da máquina chega até você pelo mesmo bot. O jeito de trabalhar que mais rende é deixar uma sessão própria só para o Telegram: a secretária.

## 💡 Por quê

- A mensagem para você nunca espera atrás de código em andamento. Uma sessão no meio de uma edição só responde quando para; a secretária responde na hora.
- As outras sessões têm um lugar só para reportar. As perguntas e os avisos de espera delas continuam chegando sozinhos ao Telegram, e as suas respostas voltam para a sessão que perguntou, mas a secretária também repassa o que elas mandam, pede o andamento e entrega cada pedido à sessão dona dele.
- Ela fica leve. A secretária não edita o repositório, então o contexto dela fica livre para conversar com você.

## 📋 Requisitos

A secretária entrega os pedidos às outras sessões com as ferramentas `ListAgents` e `SendMessage` do Claude Code, então precisa de um Claude Code com mensagens entre sessões. As sessões de trabalho também precisam dele, já que uma sessão sem isso não aparece para a secretária: se ela não enxergar as suas outras sessões, atualize o Claude Code e abra de novo essas sessões e o `claude --telegram`.

## 🛠 Como

1. Abra as sessões de trabalho como sempre, uma por tarefa, com `claude`. No Telegram, as perguntas e os avisos de espera de cada sessão a identificam como `[<nome>]`: o nome da sessão ou, sem um, `<pasta>#<início do id da sessão>`. Responder a um aviso de espera leva a sua resposta à sessão que ele identifica.
2. Abra mais uma com `claude --telegram`. Essa é a secretária: a única sessão com o canal ligado.
3. Peça as coisas pelo Telegram. A secretária manda cada pedido à sessão certa e traz as respostas.

Se você já usa uma sessão orquestradora, que divide o trabalho entre as outras, abra essa com `claude --telegram`: a orquestradora vira a secretária.

## 💰 Quanto custa

A secretária é mais uma sessão aberta, com o próprio contexto. Prints e vídeos no Telegram gastam mais tokens; o setup pergunta se você os quer (o `/bcct:visuals` muda depois) e se a secretária confere cada imagem antes de enviar.
