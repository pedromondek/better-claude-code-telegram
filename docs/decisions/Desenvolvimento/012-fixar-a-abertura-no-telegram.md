# 012. O anúncio fixa a abertura de cada versão e desafixa a anterior

> **Versão:** 1 · **Decidido por:** pedromondek
> **Card:** [#28](https://github.com/pedromondek/better-claude-code-telegram/issues/28)
> **Branch:** `0027-releases-show-how-to-install-and-update`
> **Criado em:** 2026-11-26 22:34 · **Atualizado em:** —
> **Âncoras:** `scripts/release-announce.mjs` (`pinOpening`, `openingVersionOf`, `withResume`, `resumeEntry`, `postAnnouncements`)

**Decisão:** depois do último post de cada canal, o `release:announce` lê a mensagem fixada do canal (`getChat`, `pinned_message`), desafixa (`unpinChatMessage`) a abertura de outra versão só quando ela é nossa, reconhecida pelo link de Release do repositório com uma versão válida nas entities `text_link`, e fixa (`pinChatMessage`) a abertura nova; uma abertura que já é a fixada não é fixada de novo. Quando a fixada é a abertura de uma versão mais nova (`compareVersions`), o canal fecha sem trocar o pin e diz `opening kept, v<versão> is pinned`, para que uma retomada antiga não tire o pin da versão atual. O pin é o último passo do canal: `<canal>=done` só vem depois dele, e `<canal>=<abertura>:<total>` retoma só o pin, também quando a resposta do pin se perde, porque fixar de novo não muda nada. No `DRY_RUN`, o pin acontece no canal de teste.

**Porquê:** a abertura de uma versão some do topo assim que as demos chegam como respostas a ela, e quem abre o canal depois não vê qual é a versão atual. Em canal, o bot precisa do direito de admin `can_edit_messages` ("Editar mensagens", que os quatro canais dão) para fixar e desafixar, e a Bot API não notifica fixação em canal. O `pinned_message` do `getChat` é só a fixada mais recente, e a Bot API não lista as outras: quando alguém fixa outra mensagem à mão por cima da abertura, o anúncio seguinte não a vê e ela continua fixada, para o mantenedor desafixar à mão.

**Descartado:** manter todas as aberturas fixadas (acumulam no topo do canal); fixar à mão a cada release (fácil de esquecer, e a retomada do workflow não saberia); desafixar qualquer mensagem fixada (tiraria um fixado posto à mão pelo mantenedor); guardar o id de cada abertura fora do Telegram para desafixá-la mesmo sem ser a fixada mais recente (um lugar novo de estado para um caso que só existe quando alguém fixa à mão); falhar o run quando a fixada é de uma versão mais nova (os posts já foram, e repetir daria o mesmo erro).
