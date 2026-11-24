export const LOCALES = ["en-us", "pt-br"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en-us";

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

export interface HeldCounts {
  questions: number;
  notices: number;
  permissions: number;
}

function counted(
  count: number,
  singular: string,
  plural: string,
): string | null {
  if (count === 0) return null;

  return `${count} ${count === 1 ? singular : plural}`;
}

function heldList(parts: (string | null)[]): string {
  return parts.filter((part) => part !== null).join(", ");
}

const DONE_BUTTON_EN = "✅ Done";
const DONE_BUTTON_PT = "✅ Concluir";

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
    "✍️ Other answer: tap the button and reply quoting the request it opens.",
  otherButton: "✍️ Other answer (type it)",
  doneButton: DONE_BUTTON_EN,
  answeredInTerminal: "Answered in the terminal",
  notAuthorized: "Not authorized.",
  questionClosed: "This question is already closed.",
  questionAlreadyAnswered: "This question was already answered.",
  writeOtherAnswer: (
    questionNumber: number,
    header: string | null,
    replaces: string | null,
  ): string =>
    `✍️ Type here the answer to question ${questionNumber}${header ? ` [${header}]` : ""}.${replaces === null ? "" : `\n🔁 Replaces the answer typed before: “${replaces}”.`}`,
  otherNeedsPrompt: (questionNumber: number, header: string | null): string =>
    `ℹ️ That went to Claude as a message. To answer question ${questionNumber}${header ? ` [${header}]` : ""} with text, tap “✍️ Other answer” again and reply quoting the request.`,
  otherQuestionClosed: (
    questionNumber: number,
    header: string | null,
  ): string =>
    `ℹ️ Question ${questionNumber}${header ? ` [${header}]` : ""} is already closed; this text went to Claude as a message.`,
  askDeleteFailed: (error: string): string =>
    `ask: failed to delete the Other request: ${error}`,
  otherAlreadyAnswered: (
    questionNumber: number,
    header: string | null,
    answer: string,
  ): string =>
    `⚠️ Question ${questionNumber}${header ? ` [${header}]` : ""} was already answered with ${answer}; this text was not used.`,
  answersDelivered:
    "✅ Answers delivered: the terminal question was answered with them.",
  askEditFailed: (error: string): string =>
    `ask: failed to edit the buttons: ${error}`,
  concludeReminder: `☝️ **Only this one is left to conclude**: tap ${DONE_BUTTON_EN}`,
  concludeLeftLine: `✅ Only this one is left: tap ${DONE_BUTTON_EN}`,
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
  pingRepeated: (instance: string): string =>
    `ping: notice from [${instance}] same as the last one, not sent`,
  quietStarted: (end: string): string =>
    `🌙 Quiet hours until ${end}: waiting notices, questions and permission requests stay in the terminal until then.\nTo let a question through now: /bcct:release in the terminal.\nTo turn them off: /bcct:quiet-hours.`,
  quietEnded: ({ questions, notices, permissions }: HeldCounts): string =>
    `☀️ Quiet hours are over. Held until now, coming here: ${heldList([
      counted(questions, "question", "questions"),
      counted(notices, "waiting notice", "waiting notices"),
      counted(permissions, "permission request", "permission requests"),
    ])}.`,
  quietNoticeFailed: (error: string): string =>
    `quiet hours: failed to notify the chat: ${error}`,
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
    `↩️ In reply to ${fromBot ? "Claude's message" : "their own message"}`,
  replyHeaderOther: (name: string): string =>
    `↩️ In reply to a message from ${name}`,
  instanceNameSample: "name",
  mermaidUsage: (command: string): string => `Usage: ${command} <file.mmd>`,
  mermaidMissingCli:
    "mmdc is missing: install it with 'npm install -g @mermaid-js/mermaid-cli'.",
  mermaidFailed: (outputPath: string): string =>
    `mmdc failed to render ${outputPath}.`,
  captureUsage: (command: string): string => `Usage: ${command} <spec.json>`,
  captureMissingChromium:
    "The Chromium of Playwright is missing: install it with 'npx playwright install chromium'.",
  captureMissingFfmpeg:
    "ffmpeg is missing for the video: install it with 'sudo apt install ffmpeg', 'brew install ffmpeg' or 'winget install ffmpeg'.",
  captureInvalidSpec: (detail: string): string =>
    `The capture spec is not valid: ${detail}.`,
  captureFailed: (detail: string): string => `The capture failed: ${detail}.`,
  captureFfmpegFailed: (outputPath: string): string =>
    `ffmpeg failed to write ${outputPath}.`,
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
    "✍️ Outra resposta: toque no botão e responda citando o pedido que ele abre.",
  otherButton: "✍️ Outra resposta (escrever)",
  doneButton: DONE_BUTTON_PT,
  answeredInTerminal: "Respondida no terminal",
  notAuthorized: "Não autorizado.",
  questionClosed: "Essa pergunta já foi encerrada.",
  questionAlreadyAnswered: "Essa pergunta já foi respondida.",
  writeOtherAnswer: (questionNumber, header, replaces) =>
    `✍️ Escreva aqui a resposta da pergunta ${questionNumber}${header ? ` [${header}]` : ""}.${replaces === null ? "" : `\n🔁 Substitui a resposta escrita antes: “${replaces}”.`}`,
  otherNeedsPrompt: (questionNumber, header) =>
    `ℹ️ Isso foi como mensagem para o Claude. Para responder a pergunta ${questionNumber}${header ? ` [${header}]` : ""} com texto, toque de novo em “✍️ Outra resposta” e responda citando o pedido.`,
  otherQuestionClosed: (questionNumber, header) =>
    `ℹ️ A pergunta ${questionNumber}${header ? ` [${header}]` : ""} já foi encerrada; este texto foi como mensagem para o Claude.`,
  askDeleteFailed: (error) =>
    `ask: falha ao apagar o pedido de Outro: ${error}`,
  otherAlreadyAnswered: (questionNumber, header, answer) =>
    `⚠️ A pergunta ${questionNumber}${header ? ` [${header}]` : ""} já foi respondida com ${answer}; este texto não foi usado.`,
  answersDelivered:
    "✅ Respostas entregues: a pergunta do terminal foi respondida com elas.",
  askEditFailed: (error) => `ask: falha ao editar botões: ${error}`,
  concludeReminder: `☝️ **Falta só concluir esta**: toque em ${DONE_BUTTON_PT}`,
  concludeLeftLine: `✅ Só falta esta: toque em ${DONE_BUTTON_PT}`,
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
  pingRepeated: (instance) =>
    `ping: aviso de [${instance}] igual ao último, não enviado`,
  quietStarted: (end) =>
    `🌙 Silêncio até ${end}: avisos de espera, perguntas e pedidos de permissão ficam no terminal até lá.\nPara soltar uma pergunta agora: /bcct:release no terminal.\nPara desligar: /bcct:quiet-hours.`,
  quietEnded: ({ questions, notices, permissions }) =>
    `☀️ Fim do silêncio. Retido até agora, indo para cá: ${heldList([
      counted(questions, "pergunta", "perguntas"),
      counted(notices, "aviso de espera", "avisos de espera"),
      counted(permissions, "pedido de permissão", "pedidos de permissão"),
    ])}.`,
  quietNoticeFailed: (error) => `silêncio: falha ao avisar no chat: ${error}`,
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
    `↩️ Em resposta ${fromBot ? "à mensagem do Claude" : "à própria mensagem"}`,
  replyHeaderOther: (name) => `↩️ Em resposta a uma mensagem de ${name}`,
  instanceNameSample: "nome",
  mermaidUsage: (command) => `Uso: ${command} <arquivo.mmd>`,
  mermaidMissingCli:
    "Falta o mmdc: instale com 'npm install -g @mermaid-js/mermaid-cli'.",
  mermaidFailed: (outputPath) => `O mmdc falhou ao gerar ${outputPath}.`,
  captureUsage: (command) => `Uso: ${command} <spec.json>`,
  captureMissingChromium:
    "Falta o Chromium do Playwright: instale com 'npx playwright install chromium'.",
  captureMissingFfmpeg:
    "Falta o ffmpeg para o vídeo: instale com 'sudo apt install ffmpeg', 'brew install ffmpeg' ou 'winget install ffmpeg'.",
  captureInvalidSpec: (detail) =>
    `A especificação da captura não vale: ${detail}.`,
  captureFailed: (detail) => `A captura falhou: ${detail}.`,
  captureFfmpegFailed: (outputPath) =>
    `O ffmpeg falhou ao gerar ${outputPath}.`,
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
