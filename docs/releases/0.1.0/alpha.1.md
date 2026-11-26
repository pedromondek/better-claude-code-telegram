> [!TIP]
> 📣 **Follow the releases on Telegram · Acompanhe os lançamentos no Telegram**\
> 🇺🇸 [@bcct_tips](https://t.me/bcct_tips) (stable) · [@bcct_tips_prereleases](https://t.me/bcct_tips_prereleases) (every version)\
> 🇧🇷 [@bcct_tips_br](https://t.me/bcct_tips_br) (estáveis) · [@bcct_tips_prelancamentos](https://t.me/bcct_tips_prelancamentos) (todas as versões)

> [!NOTE]
> ✨ new · novo&emsp;&emsp;🐛 fix · correção&emsp;&emsp;⚡ performance · desempenho&emsp;&emsp;🔐 security · segurança

<details><summary>🇺🇸 English</summary>

### 📋 Summary

- **Answer Claude Code from Telegram, with a bot of your own:** questions arrive as buttons, and Claude tells you when it is waiting or why it stopped.
- **One bot for every Claude Code session on the machine**, with voice, tables and visual ideas.
- **One command installs it:** `npx @pedromondek/better-claude-code-telegram`, then `claude --telegram`.
- **Safe by default:** the token stays readable only by you, and only your paired account talks to the bot.

### 💬 Telegram channel

- ✨ **Answer from Telegram.** Claude's questions arrive as **buttons** on your phone; one tap answers in the terminal.

  No more walking back to the computer to unblock a session.

  ![Answering from Telegram](https://github.com/user-attachments/assets/442d10cb-1232-48e8-afd5-456e80c2bbec)
  <!-- telegram: https://github.com/user-attachments/assets/8deaad2f-b0a5-4f99-95a3-a53003e25362 -->

- ✨ **Know when Claude is waiting.** If Claude waits for you for a few minutes, Telegram tells you, with its **last message**.

  When it stops on the **usage limit** or an API error, a card says why and when it comes back.

  ![Waiting notice and quota card](https://github.com/user-attachments/assets/3c17844e-b294-4641-9b75-f3be59fcf3c6)
  <!-- telegram: https://github.com/user-attachments/assets/ca9d4a44-cf64-4152-9185-c2ddb456a87e -->

- ✨ **Every session, one bot.** Run **several Claude Code sessions** and talk to all of them through one bot.

  Each message carries the **name of its session**, so you always know who is asking.

  ![Several sessions on one bot](https://github.com/user-attachments/assets/f725460d-430e-4d29-8244-3e7a7f9becc0)
  <!-- telegram: https://github.com/user-attachments/assets/f0c0c616-a2c4-4112-b1d3-a55bc5c5e16a -->

- ✨ **Tables that read.** When Claude answers with a table, it arrives on Telegram as **aligned columns**, not a wall of pipes.

  Long messages go on in the next ones, with bold and code kept.

  ![A table on Telegram](https://github.com/user-attachments/assets/83e335e0-1e7e-4d5e-8d65-2d0c6a4d242c)
  <!-- telegram: https://github.com/user-attachments/assets/44e9b816-6dcf-42a9-b361-ca1a17bf75e3 -->

- ✨ **See the idea before it is built.** With illustrations on, Claude shows a **visual idea** as a board, today next to each proposal, and asks which one to build.

  ![A visual idea](https://github.com/user-attachments/assets/3f255fbf-af1a-42bd-9648-3418268acd8a)
  <!-- telegram: https://github.com/user-attachments/assets/07791d58-e4f2-4ada-baf8-416c9c73050e -->

- ✨ **Allow or deny from your phone.** Permission requests arrive with **See more**, **Allow** and **Deny** buttons, held back while you are active in the terminal.

  ![Allow or deny on Telegram](https://github.com/user-attachments/assets/7a21427e-378b-4c07-9183-b585b0dce7f8)
  <!-- telegram: https://github.com/user-attachments/assets/99697994-0bfc-4794-a4f4-57cdfdfb8743 -->

- ✨ **Messages when you want them.** Choose a **delay**, one for all or one per kind, and **quiet hours** that hold the messages; `bcct release` sends what is held right away.

- ✨ **A nudge for unfinished choices.** A multiple-choice question with options marked but no Done gets **one reminder**, as a reply to it.

- ✨ **Your language.** Messages in **English or Brazilian Portuguese**, chosen in the setup.

- 🐛 The waiting notice is not sent again with the same text when scheduled prompts end turns; it comes back after you type a prompt.
- 🐛 Text that Claude escapes on purpose shows as written, a line that starts with > shows as a quote, and an escaped pipe in a table shows as a pipe.
- 🐛 An answer typed through Other reaches Claude marked as typed by you on Telegram.
- 🐛 When a question goes to two chats and the copy to one of them fails partway, that chat no longer keeps half of it.
- ⚡ A long message or question context is split into Telegram messages in a moment, instead of taking longer with each line.

### 🎙️ Voice transcription

- ✨ **Talk instead of typing.** Send a **voice message**; it is transcribed **on your machine** and reaches Claude as text.

  Nothing goes to a transcription service.

  ![Voice message](https://github.com/user-attachments/assets/05bd103d-83de-418f-950c-e2c7ca763f1f)
  <!-- telegram: https://github.com/user-attachments/assets/a33debb2-9bac-4626-a3d3-0f92f1f00749 -->

### 🧰 Setup, health and update

- ✨ **Set up in one command.** `npx @pedromondek/better-claude-code-telegram` walks you through the language, the bot token and the pairing.

  It checks everything at the end, and each step runs again on its own (`bcct setup delay`) or from the `/bcct:` commands.

  ![Setup](https://github.com/user-attachments/assets/a39fe9f0-8622-4136-bbb2-00b6b5aa108d)
  <!-- telegram: https://github.com/user-attachments/assets/88ccc724-50bd-494f-a99a-88152744a7f1 -->

- ✨ **Telegram only when you ask.** `claude --telegram` opens the session with Telegram, and plain `claude` keeps working as before; `/resume` switches conversations without turning it off.

- ✨ **Check and repair.** `bcct health` checks the install, the bot, the pairing and the token protection, and `bcct health --fix` repairs what it can.

- ✨ **Update and remove cleanly.** `bcct update` updates the plugins and the binary, showing what changes and asking first; `bcct uninstall` removes only what the setup added.

- ✨ **Linux, macOS and Windows.** Linux and macOS on x64 and arm64, and native Windows with basic support.

### 📊 Status line

- ✨ **Telegram, right in your status line.** An optional indicator shows whether Telegram is **connected, connecting or down**.

  ![Telegram in the status line](https://github.com/user-attachments/assets/d78c548f-73f3-4c88-834d-ea7e06ca1322)
  <!-- telegram: https://github.com/user-attachments/assets/57fde56e-48ac-47e0-a12c-19e55aee6ee3 -->

### 🔐 Security

- 🔐 The bot token is asked without echo, saved readable only by you, and kept out of Claude Code's reach.
- 🔐 Only your paired Telegram account talks to the bot.
- 🔐 Every release binary is attested by the workflow that built it and published in an immutable GitHub Release, and the npm packages come through trusted publishing with provenance.

</details>

<details><summary>🇧🇷 Português</summary>

### 📋 Resumo

- **Responda o Claude Code pelo Telegram, com um bot só seu:** as perguntas chegam como botões, e o Claude avisa quando está esperando você ou por que parou.
- **Um bot para todas as sessões do Claude Code da máquina**, com voz, tabelas e ideias visuais.
- **Um comando instala:** `npx @pedromondek/better-claude-code-telegram`, depois `claude --telegram`.
- **Seguro por padrão:** o token fica legível só para você, e só a sua conta pareada fala com o bot.

### 💬 Canal do Telegram

- ✨ **Responda pelo Telegram.** As perguntas do Claude chegam como **botões** no celular; um toque responde no terminal.

  Não precisa voltar ao computador para destravar uma sessão.

  ![Respondendo pelo Telegram](https://github.com/user-attachments/assets/442d10cb-1232-48e8-afd5-456e80c2bbec)
  <!-- telegram: https://github.com/user-attachments/assets/2ebb9015-8a35-4414-8512-870631819d0e -->

- ✨ **Saiba quando o Claude está esperando.** Se o Claude espera você por alguns minutos, o Telegram avisa, com a **última mensagem** dele.

  Quando ele para no **limite de uso** ou num erro da API, um cartão diz por quê e quando ele volta.

  ![Aviso de espera e cartão de cota](https://github.com/user-attachments/assets/3c17844e-b294-4641-9b75-f3be59fcf3c6)
  <!-- telegram: https://github.com/user-attachments/assets/729f0a26-c57b-478b-b202-70f7bbe853c3 -->

- ✨ **Todas as sessões, um bot.** Rode **várias sessões do Claude Code** e fale com todas por um bot só.

  Cada mensagem leva o **nome da sessão**, então você sempre sabe quem está perguntando.

  ![Várias sessões num bot](https://github.com/user-attachments/assets/f725460d-430e-4d29-8244-3e7a7f9becc0)
  <!-- telegram: https://github.com/user-attachments/assets/93464960-d231-4137-939c-b5de5eb7c3b4 -->

- ✨ **Tabelas legíveis.** Quando o Claude responde com uma tabela, ela chega no Telegram em **colunas alinhadas**, e não num monte de barras.

  Mensagem longa continua nas seguintes, com negrito e código preservados.

  ![Uma tabela no Telegram](https://github.com/user-attachments/assets/83e335e0-1e7e-4d5e-8d65-2d0c6a4d242c)
  <!-- telegram: https://github.com/user-attachments/assets/7c60c38f-8e87-4b27-ae0a-4cbdd45fa284 -->

- ✨ **Veja a ideia antes de construir.** Com as ilustrações ligadas, o Claude mostra a **ideia visual** num quadro, o hoje ao lado de cada proposta, e pergunta qual construir.

  ![Uma ideia visual](https://github.com/user-attachments/assets/3f255fbf-af1a-42bd-9648-3418268acd8a)
  <!-- telegram: https://github.com/user-attachments/assets/38c1b283-e9ed-48e1-ad39-25516291462b -->

- ✨ **Permita ou negue pelo celular.** Os pedidos de permissão chegam com os botões **See more**, **Allow** e **Deny**, segurados enquanto você está ativo no terminal.

  ![Permitir ou negar pelo Telegram](https://github.com/user-attachments/assets/7a21427e-378b-4c07-9183-b585b0dce7f8)
  <!-- telegram: https://github.com/user-attachments/assets/d792e87a-5d6a-46d3-a303-9c64235b1d1e -->

- ✨ **Mensagens na hora que você quer.** Escolha um **atraso**, um só ou um por tipo, e um **horário de silêncio** que segura as mensagens; o `bcct release` manda na hora o que está segurado.

- ✨ **Um lembrete para escolhas pela metade.** A pergunta de escolha múltipla com opções marcadas e sem Concluir ganha **um lembrete**, em resposta a ela.

- ✨ **O seu idioma.** Mensagens em **inglês ou português do Brasil**, escolhido no setup.

- 🐛 O aviso de espera não é enviado de novo com o mesmo texto quando prompts agendados terminam turnos; ele volta depois que você digita um prompt.
- 🐛 O texto que o Claude escapa de propósito aparece como foi escrito, a linha que começa com > vira citação, e a barra escapada numa tabela aparece como barra.
- 🐛 A resposta digitada pelo Outro chega ao Claude marcada como digitada por você no Telegram.
- 🐛 Quando uma pergunta vai para dois chats e a cópia para um deles falha no meio, esse chat não fica mais com metade dela.
- ⚡ Uma mensagem ou um contexto de pergunta longo é dividido em mensagens do Telegram num instante, em vez de demorar mais a cada linha.

### 🎙️ Transcrição de voz

- ✨ **Fale em vez de digitar.** Mande um **áudio**; ele é transcrito **na sua máquina** e chega ao Claude como texto.

  Nada vai para um serviço de transcrição.

  ![Mensagem de voz](https://github.com/user-attachments/assets/05bd103d-83de-418f-950c-e2c7ca763f1f)
  <!-- telegram: https://github.com/user-attachments/assets/bae2ad7c-8284-4665-9ef0-8a397e43ca27 -->

### 🧰 Setup, saúde e atualização

- ✨ **Configure com um comando.** O `npx @pedromondek/better-claude-code-telegram` guia você pelo idioma, o token do bot e o pareamento.

  No fim, ele confere tudo, e cada etapa roda de novo sozinha (`bcct setup delay`) ou pelos comandos `/bcct:`.

  ![Setup](https://github.com/user-attachments/assets/a39fe9f0-8622-4136-bbb2-00b6b5aa108d)
  <!-- telegram: https://github.com/user-attachments/assets/beac7c21-bd8d-4b55-a2ee-09517802a757 -->

- ✨ **Telegram só quando você pede.** O `claude --telegram` abre a sessão com o Telegram, e o `claude` comum segue como antes; o `/resume` troca de conversa sem desligar.

- ✨ **Confira e conserte.** O `bcct health` confere a instalação, o bot, o pareamento e a proteção do token, e o `bcct health --fix` conserta o que dá.

- ✨ **Atualize e remova sem sobra.** O `bcct update` atualiza os plugins e o binário, mostrando o que muda e perguntando antes; o `bcct uninstall` remove só o que o setup pôs.

- ✨ **Linux, macOS e Windows.** Linux e macOS em x64 e arm64, e Windows nativo com suporte básico.

### 📊 Status line

- ✨ **O Telegram na sua status line.** Um indicador opcional mostra se o Telegram está **conectado, conectando ou fora**.

  ![O Telegram na status line](https://github.com/user-attachments/assets/d78c548f-73f3-4c88-834d-ea7e06ca1322)
  <!-- telegram: https://github.com/user-attachments/assets/746e67f8-205d-4173-90be-bd7a2d7b8608 -->

### 🔐 Segurança

- 🔐 O token do bot é pedido sem eco, salvo legível só para você e fora do alcance do Claude Code.
- 🔐 Só a sua conta pareada do Telegram fala com o bot.
- 🔐 Todo binário da release é atestado pelo workflow que o gerou e publicado numa GitHub Release imutável, e os pacotes npm vêm por trusted publishing com proveniência.

</details>
