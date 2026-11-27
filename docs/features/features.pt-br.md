# ✨ Funcionalidades

Toda funcionalidade que as versões lançaram, como as notas a descrevem. O release escreve este arquivo a partir de `docs/releases` com `npm run docs:features`; a doc de [versionamento](../versioning/versioning.pt-br.md) traz o fluxo.

## 💬 Canal do Telegram

- ✨ **Responda pelo Telegram.** As perguntas do Claude chegam como **botões** no celular; um toque responde no terminal.

  Não precisa voltar ao computador para destravar uma sessão.

  [▶ Demonstração](https://github.com/user-attachments/assets/442d10cb-1232-48e8-afd5-456e80c2bbec)

- ✨ **Saiba quando o Claude está esperando.** Se o Claude espera você por alguns minutos, o Telegram avisa, com a **última mensagem** dele.

  Quando ele para no **limite de uso** ou num erro da API, um cartão diz por quê e quando ele volta.

  [▶ Demonstração](https://github.com/user-attachments/assets/3c17844e-b294-4641-9b75-f3be59fcf3c6)

- ✨ **Todas as sessões, um bot.** Rode **várias sessões do Claude Code** e fale com todas por um bot só.

  Cada mensagem leva o **nome da sessão**, então você sempre sabe quem está perguntando.

  [▶ Demonstração](https://github.com/user-attachments/assets/f725460d-430e-4d29-8244-3e7a7f9becc0)

- ✨ **Tabelas legíveis.** Quando o Claude responde com uma tabela, ela chega no Telegram em **colunas alinhadas**, e não num monte de barras.

  Mensagem longa continua nas seguintes, com negrito e código preservados.

  [▶ Demonstração](https://github.com/user-attachments/assets/83e335e0-1e7e-4d5e-8d65-2d0c6a4d242c)

- ✨ **Veja a ideia antes de construir.** Com as ilustrações ligadas, o Claude mostra a **ideia visual** num quadro, o hoje ao lado de cada proposta, e pergunta qual construir.

  [▶ Demonstração](https://github.com/user-attachments/assets/3f255fbf-af1a-42bd-9648-3418268acd8a)

- ✨ **Permita ou negue pelo celular.** Os pedidos de permissão chegam com os botões **See more**, **Allow** e **Deny**, segurados enquanto você está ativo no terminal.

  [▶ Demonstração](https://github.com/user-attachments/assets/7a21427e-378b-4c07-9183-b585b0dce7f8)

- ✨ **Mensagens na hora que você quer.** Escolha um **atraso**, um só ou um por tipo, e um **horário de silêncio** que segura as mensagens; o `bcct release` manda na hora o que está segurado.

- ✨ **Um lembrete para escolhas pela metade.** A pergunta de escolha múltipla com opções marcadas e sem Concluir ganha **um lembrete**, em resposta a ela.

- ✨ **O seu idioma.** Mensagens em **inglês ou português do Brasil**, escolhido no setup.

## 🎙️ Transcrição de voz

- ✨ **Fale em vez de digitar.** Mande um **áudio**; ele é transcrito **na sua máquina** e chega ao Claude como texto.

  Nada vai para um serviço de transcrição.

  [▶ Demonstração](https://github.com/user-attachments/assets/05bd103d-83de-418f-950c-e2c7ca763f1f)

## 🧰 Setup, saúde e atualização

- ✨ **Configure com um comando.** O `npx @pedromondek/better-claude-code-telegram` guia você pelo idioma, o token do bot e o pareamento.

  No fim, ele confere tudo, e cada etapa roda de novo sozinha (`bcct setup delay`) ou pelos comandos `/bcct:`.

  [▶ Demonstração](https://github.com/user-attachments/assets/a39fe9f0-8622-4136-bbb2-00b6b5aa108d)

- ✨ **Telegram só quando você pede.** O `claude --telegram` abre a sessão com o Telegram, e o `claude` comum segue como antes; o `/resume` troca de conversa sem desligar.

- ✨ **Confira e conserte.** O `bcct health` confere a instalação, o bot, o pareamento e a proteção do token, e o `bcct health --fix` conserta o que dá.

- ✨ **Atualize e remova sem sobra.** O `bcct update` atualiza os plugins e o binário, mostrando o que muda e perguntando antes; o `bcct uninstall` remove só o que o setup pôs.

- ✨ **Linux, macOS e Windows.** Linux e macOS em x64 e arm64, e Windows nativo com suporte básico.

## 📊 Status line

- ✨ **O Telegram na sua status line.** Um indicador opcional mostra se o Telegram está **conectado, conectando ou fora**.

  [▶ Demonstração](https://github.com/user-attachments/assets/d78c548f-73f3-4c88-834d-ea7e06ca1322)
