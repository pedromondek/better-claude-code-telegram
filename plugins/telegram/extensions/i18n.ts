export const LOCALES = ["en-us", "pt-br"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en-us";

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

const enUs = {
  whisperLanguage: "en",
  languageName: "English",
  extensionsStarted: "better-claude-code-telegram extensions started",
  contextText: (context: string): string =>
    `📝 Context (what Claude wrote in the terminal before the question):\n\n${context}`,
  questionTitle: (instance: string | null): string =>
    `❓ Question open in the terminal${instance ? ` from [${instance}]` : ""}`,
  previewLabel: "Preview:",
  multiSelectHint: "Multiple choice: tap every option you want, then ✅ Done.",
  otherHint:
    "✍️ Other answer: tap the button and type your answer here in the chat.",
  otherButton: "✍️ Other answer (type it)",
  doneButton: "✅ Done",
  answeredInTerminal: "Answered in the terminal",
  notAuthorized: "Not authorized.",
  questionClosed: "This question is already closed.",
  questionAlreadyAnswered: "This question was already answered.",
  writeOtherAnswer: (questionNumber: number, header: string | null): string =>
    `✍️ Type here the answer to question ${questionNumber}${header ? ` [${header}]` : ""}.`,
  answersDelivered:
    "✅ Answers delivered: the terminal question was answered with them.",
  askEditFailed: (error: string): string =>
    `ask: failed to edit the buttons: ${error}`,
  askSent: (askId: string, instance: string): string =>
    `ask: question ${askId} from [${instance}] sent to Telegram`,
  askAnsweredInTerminal: (askId: string): string =>
    `ask: question ${askId} answered in the terminal`,
  askCycleFailed: (error: string): string =>
    `ask: mirror cycle failed: ${error}`,
  askAnswersDelivered: (askId: string): string =>
    `ask: answers to question ${askId} delivered through Telegram`,
  askConfirmFailed: (error: string): string =>
    `ask: failed to confirm in the chat: ${error}`,
  waitingWho: (instance: string | null): string =>
    instance ? `The Claude instance [${instance}]` : "Claude",
  waitingPing: (who: string, delay: string, text: string): string =>
    `⏳ ${who} has been waiting for you in the terminal for more than ${delay}.\n\nLast message:\n\n${text}`,
  pingFailed: (error: string): string =>
    `ping: failed to notify the chat: ${error}`,
  pingSent: (instance: string): string =>
    `ping: notice from [${instance}] sent`,
  permissionSentNow: (requestId: string): string =>
    `permission ${requestId}: sent right away (conversation on Telegram)`,
  permissionResolvedInTerminal: (requestId: string): string =>
    `permission ${requestId}: resolved in the terminal, not sent`,
  permissionSent: (requestId: string): string =>
    `permission ${requestId}: sent to Telegram`,
  transcriptionText: (text: string): string =>
    `🎤 Audio transcription:\n\n${text}`,
  audioUnavailable: "audio file unavailable",
  emptyTranscription: "empty transcription",
  transcribed: (model: string, text: string): string =>
    `audio transcribed with the ${model} model: ${text}`,
  transcriptionFailed: (error: string): string =>
    `failed to transcribe the audio: ${error}`,
  transcriptionFailedChat:
    "⚠️ I couldn't transcribe the audio; it went to Claude as an attachment.",
  replyHeader: (fromBot: boolean): string =>
    `↩️ In reply to ${fromBot ? "Claude's message" : "your message"}`,
  instanceNameSample: "name",
  mermaidUsage: (command: string): string => `Usage: ${command} <file.mmd>`,
  mermaidMissingCli:
    "mmdc is missing: install it with 'npm install -g @mermaid-js/mermaid-cli'.",
  mermaidFailed: (outputPath: string): string =>
    `mmdc failed to render ${outputPath}.`,
};

export type Messages = typeof enUs;

const ptBr: Messages = {
  whisperLanguage: "pt",
  languageName: "Brazilian Portuguese",
  extensionsStarted: "extensões do better-claude-code-telegram iniciadas",
  contextText: (context) =>
    `📝 Contexto (o que o Claude escreveu no terminal antes da pergunta):\n\n${context}`,
  questionTitle: (instance) =>
    `❓ Pergunta aberta no terminal${instance ? ` de [${instance}]` : ""}`,
  previewLabel: "Prévia:",
  multiSelectHint:
    "Escolha múltipla: toque em todas que quiser e depois em ✅ Concluir.",
  otherHint:
    "✍️ Outra resposta: toque no botão e escreva a resposta aqui no chat.",
  otherButton: "✍️ Outra resposta (escrever)",
  doneButton: "✅ Concluir",
  answeredInTerminal: "Respondida no terminal",
  notAuthorized: "Não autorizado.",
  questionClosed: "Essa pergunta já foi encerrada.",
  questionAlreadyAnswered: "Essa pergunta já foi respondida.",
  writeOtherAnswer: (questionNumber, header) =>
    `✍️ Escreva aqui a resposta da pergunta ${questionNumber}${header ? ` [${header}]` : ""}.`,
  answersDelivered:
    "✅ Respostas entregues: a pergunta do terminal foi respondida com elas.",
  askEditFailed: (error) => `ask: falha ao editar botões: ${error}`,
  askSent: (askId, instance) =>
    `ask: pergunta ${askId} de [${instance}] enviada ao Telegram`,
  askAnsweredInTerminal: (askId) =>
    `ask: pergunta ${askId} respondida no terminal`,
  askCycleFailed: (error) => `ask: falha no ciclo do espelho: ${error}`,
  askAnswersDelivered: (askId) =>
    `ask: respostas da pergunta ${askId} entregues pelo Telegram`,
  askConfirmFailed: (error) => `ask: falha ao confirmar no chat: ${error}`,
  waitingWho: (instance) =>
    instance ? `A instância [${instance}] do Claude` : "O Claude",
  waitingPing: (who, delay, text) =>
    `⏳ ${who} está esperando você no terminal há mais de ${delay}.\n\nÚltima mensagem dele:\n\n${text}`,
  pingFailed: (error) => `ping: falha ao avisar no chat: ${error}`,
  pingSent: (instance) => `ping: aviso de [${instance}] enviado`,
  permissionSentNow: (requestId) =>
    `permissão ${requestId}: enviada na hora (conversa no Telegram)`,
  permissionResolvedInTerminal: (requestId) =>
    `permissão ${requestId}: resolvida no terminal, não enviada`,
  permissionSent: (requestId) => `permissão ${requestId}: enviada ao Telegram`,
  transcriptionText: (text) => `🎤 Transcrição do áudio:\n\n${text}`,
  audioUnavailable: "arquivo de áudio indisponível",
  emptyTranscription: "transcrição vazia",
  transcribed: (model, text) =>
    `áudio transcrito com o modelo ${model}: ${text}`,
  transcriptionFailed: (error) => `falha ao transcrever o áudio: ${error}`,
  transcriptionFailedChat:
    "⚠️ Não consegui transcrever o áudio; ele foi como anexo para o Claude.",
  replyHeader: (fromBot) =>
    `↩️ Em resposta ${fromBot ? "à mensagem do Claude" : "à sua mensagem"}`,
  instanceNameSample: "nome",
  mermaidUsage: (command) => `Uso: ${command} <arquivo.mmd>`,
  mermaidMissingCli:
    "Falta o mmdc: instale com 'npm install -g @mermaid-js/mermaid-cli'.",
  mermaidFailed: (outputPath) => `O mmdc falhou ao gerar ${outputPath}.`,
};

export const MESSAGES: Record<Locale, Messages> = {
  "en-us": enUs,
  "pt-br": ptBr,
};

export function messagesFor(locale: Locale): Messages {
  return MESSAGES[locale];
}

export function describeError(error: unknown): string {
  return String(error);
}
