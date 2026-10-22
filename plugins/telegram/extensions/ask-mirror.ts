import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  ANSWERED_CALLBACK,
  answerQuestion,
  answersByQuestion,
  buildKeyboard,
  emptyProgress,
  finalKeyboard,
  isAnswered,
  isAskRecord,
  isComplete,
  optionAnswer,
  otherAnswer,
  parseAskCallback,
  renderContextText,
  renderQuestionText,
  selectionAnswer,
  shortIdFor,
  toggleSelection,
  type AskProgress,
  type AskRecord,
  type KeyboardButton,
} from "./ask-format.ts";
import { isQuietTime, readLocale, readQuietHours } from "./config.ts";
import { describeError, messagesFor, type Messages } from "./i18n.ts";
import type { Log } from "./log.ts";
import { toTelegramHtmlChunks } from "./telegram-html.ts";
import { conversationOnTelegram } from "./waiting-ping.ts";

interface SentMessage {
  chatId: string;
  questionIndex: number;
  messageId: number;
}

interface SentState {
  shortId: string;
  messages: SentMessage[];
  progress: AskProgress;
  awaitingOther: number | null;
  completed: boolean;
}

interface ReplyMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

interface BotApi {
  sendMessage(
    chatId: string,
    text: string,
    options?: { reply_markup?: ReplyMarkup; parse_mode?: "HTML" },
  ): Promise<{ message_id: number }>;
  editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    options: { reply_markup: ReplyMarkup },
  ): Promise<unknown>;
}

export interface CallbackContext {
  callbackQuery?: { data?: string };
  from?: { id: number; username?: string };
  chat?: { id: number };
  answerCallbackQuery(options?: { text?: string }): Promise<unknown>;
}

interface AskMirrorOptions {
  api: BotApi;
  appDir: string;
  allowedChats: () => string[];
  log: Log;
  messages?: () => Messages;
}

export interface AskMirror {
  tick: () => Promise<void>;
  handleCallback: (ctx: CallbackContext) => Promise<boolean>;
  consumeText: (chatId: string, text: string) => Promise<boolean>;
}

export const SENT_SUFFIX = ".telegram.json";
export const ANSWER_SUFFIX = ".answer.json";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function toReplyMarkup(rows: KeyboardButton[][]): ReplyMarkup {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.data })),
    ),
  };
}

function readJson(file: string): unknown {
  let value: unknown;

  try {
    value = JSON.parse(readFileSync(file).toString());
  } catch {}

  return value;
}

function isSentState(value: unknown): value is SentState {
  if (!(value instanceof Object)) return false;

  const sent = value as Partial<SentState>;

  return (
    typeof sent.shortId === "string" &&
    Array.isArray(sent.messages) &&
    typeof sent.progress === "object" &&
    sent.progress !== null
  );
}

export function createAskMirror({
  api,
  appDir,
  allowedChats,
  log,
  messages = (): Messages => messagesFor(readLocale(appDir)),
}: AskMirrorOptions): AskMirror {
  const asksDir = join(appDir, "asks");
  let ticking = false;

  const recordFile = (id: string): string => join(asksDir, `${id}.json`);
  const sentFile = (id: string): string => join(asksDir, `${id}${SENT_SUFFIX}`);
  const answerFile = (id: string): string =>
    join(asksDir, `${id}${ANSWER_SUFFIX}`);
  const closedFile = (id: string): string => join(asksDir, `${id}.closed`);

  function listAskIds(): string[] {
    try {
      return readdirSync(asksDir)
        .filter((name) => /^[\w-]+\.json$/.test(name))
        .map((name) => name.slice(0, -".json".length));
    } catch {
      return [];
    }
  }

  function readRecord(id: string): AskRecord | null {
    const value = readJson(recordFile(id));

    return isAskRecord(value) ? value : null;
  }

  function readSent(id: string): SentState | null {
    const value = readJson(sentFile(id));

    return isSentState(value) ? value : null;
  }

  function saveSent(id: string, sent: SentState): void {
    writeFileSync(sentFile(id), JSON.stringify(sent), { mode: 0o600 });
  }

  function removeAsk(id: string): void {
    for (const file of [recordFile(id), sentFile(id), closedFile(id)]) {
      rmSync(file, { force: true });
    }
  }

  async function sendHtml(
    chatId: string,
    markdown: string,
    keyboard?: KeyboardButton[][],
  ): Promise<number> {
    const chunks = toTelegramHtmlChunks(markdown);
    let lastMessageId = 0;

    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      const sent = await api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        ...(isLast && keyboard
          ? { reply_markup: toReplyMarkup(keyboard) }
          : {}),
      });

      lastMessageId = sent.message_id;
    }

    return lastMessageId;
  }

  async function editQuestionMarkup(
    sent: SentState,
    questionIndex: number,
    rows: KeyboardButton[][],
  ): Promise<void> {
    const text = messages();
    const sentMessages = sent.messages.filter(
      (message) => message.questionIndex === questionIndex,
    );

    await Promise.all(
      sentMessages.map((message) =>
        api
          .editMessageReplyMarkup(message.chatId, message.messageId, {
            reply_markup: toReplyMarkup(rows),
          })
          .catch((error: unknown) =>
            log(text.askEditFailed(describeError(error))),
          ),
      ),
    );
  }

  async function sendAsk(record: AskRecord): Promise<void> {
    const text = messages();
    const shortId = shortIdFor(record.id);
    const total = record.questions.length;
    const sentMessages: SentMessage[] = [];

    for (const chatId of allowedChats()) {
      if (record.context) {
        await sendHtml(chatId, renderContextText(record.context, text));
      }

      for (const [questionIndex, question] of record.questions.entries()) {
        const messageId = await sendHtml(
          chatId,
          renderQuestionText(
            question,
            questionIndex,
            total,
            text,
            record.instance ?? null,
          ),
          buildKeyboard(question, shortId, questionIndex, text),
        );

        sentMessages.push({ chatId, questionIndex, messageId });
      }
    }

    saveSent(record.id, {
      shortId,
      messages: sentMessages,
      progress: emptyProgress(),
      awaitingOther: null,
      completed: false,
    });
    log(text.askSent(record.id, record.instance ?? "telegram"));
  }

  async function closeInTerminal(
    sent: SentState,
    record: AskRecord,
  ): Promise<void> {
    const openQuestions = record.questions
      .map((_, questionIndex) => questionIndex)
      .filter((questionIndex) => !isAnswered(sent.progress, questionIndex));
    const answeredInTerminal = messages().answeredInTerminal;

    await Promise.all(
      openQuestions.map((questionIndex) =>
        editQuestionMarkup(
          sent,
          questionIndex,
          finalKeyboard(answeredInTerminal),
        ),
      ),
    );
  }

  async function tick(): Promise<void> {
    if (ticking) return;

    ticking = true;

    try {
      const now = Date.now();
      const quiet = isQuietTime(new Date(now), readQuietHours(appDir));
      const onTelegram = conversationOnTelegram(appDir);

      for (const id of listAskIds()) {
        const record = readRecord(id);
        const sent = readSent(id);

        if (!record) {
          removeAsk(id);
          continue;
        }

        if (existsSync(closedFile(id))) {
          if (sent && !sent.completed) {
            await closeInTerminal(sent, record);
            log(messages().askAnsweredInTerminal(id));
          }

          removeAsk(id);
          rmSync(answerFile(id), { force: true });
          continue;
        }

        if (now - record.createdAt > MAX_AGE_MS) {
          removeAsk(id);
          rmSync(answerFile(id), { force: true });
          continue;
        }

        if (!sent && (now >= record.dueAt || onTelegram) && !quiet) {
          await sendAsk(record);
        }
      }
    } catch (error) {
      log(messages().askCycleFailed(describeError(error)));
    } finally {
      ticking = false;
    }
  }

  function findByShortId(
    shortId: string,
  ): { record: AskRecord; sent: SentState } | null {
    for (const id of listAskIds()) {
      const sent = readSent(id);
      const record = readRecord(id);

      if (sent?.shortId === shortId && record) return { record, sent };
    }

    return null;
  }

  async function complete(
    record: AskRecord,
    sent: SentState,
    chatId: string,
  ): Promise<void> {
    saveSent(record.id, { ...sent, completed: true, awaitingOther: null });

    if (existsSync(closedFile(record.id))) return;

    const text = messages();

    writeFileSync(
      answerFile(record.id),
      JSON.stringify({
        answers: answersByQuestion(record.questions, sent.progress),
      }),
      { mode: 0o600 },
    );
    log(text.askAnswersDelivered(record.id));
    await api
      .sendMessage(chatId, text.answersDelivered)
      .catch((error: unknown) =>
        log(text.askConfirmFailed(describeError(error))),
      );
  }

  async function finalize(
    record: AskRecord,
    sent: SentState,
    questionIndex: number,
    answer: string,
    chatId: string,
  ): Promise<void> {
    const updated: SentState = {
      ...sent,
      progress: answerQuestion(sent.progress, questionIndex, answer),
      awaitingOther:
        sent.awaitingOther === questionIndex ? null : sent.awaitingOther,
    };

    saveSent(record.id, updated);
    await editQuestionMarkup(updated, questionIndex, finalKeyboard(answer));

    if (isComplete(updated.progress, record.questions.length)) {
      await complete(record, updated, chatId);
    }
  }

  async function handleCallback(ctx: CallbackContext): Promise<boolean> {
    const data = ctx.callbackQuery?.data;

    if (data === ANSWERED_CALLBACK) {
      await ctx.answerCallbackQuery().catch(() => undefined);

      return true;
    }

    const parsed = parseAskCallback(String(data));

    if (!parsed) return false;

    const text = messages();
    const senderId = ctx.from?.id;

    if (senderId === undefined || !allowedChats().includes(String(senderId))) {
      await ctx
        .answerCallbackQuery({ text: text.notAuthorized })
        .catch(() => undefined);

      return true;
    }

    const found = findByShortId(parsed.shortId);
    const question = found?.record.questions[parsed.questionIndex];

    if (
      !found ||
      !question ||
      found.sent.completed ||
      existsSync(closedFile(found.record.id))
    ) {
      await ctx
        .answerCallbackQuery({ text: text.questionClosed })
        .catch(() => undefined);

      return true;
    }

    const { record, sent } = found;
    const chatId = String(ctx.chat?.id ?? senderId);

    if (isAnswered(sent.progress, parsed.questionIndex)) {
      await ctx
        .answerCallbackQuery({ text: text.questionAlreadyAnswered })
        .catch(() => undefined);

      return true;
    }

    await ctx.answerCallbackQuery().catch(() => undefined);

    if (parsed.action === "other") {
      saveSent(record.id, { ...sent, awaitingOther: parsed.questionIndex });
      await api.sendMessage(
        chatId,
        text.writeOtherAnswer(
          parsed.questionIndex + 1,
          question.header ?? null,
        ),
      );

      return true;
    }

    if (parsed.action === "done") {
      const answer = selectionAnswer(
        question,
        sent.progress.selections[parsed.questionIndex] ?? [],
      );

      if (answer) {
        await finalize(record, sent, parsed.questionIndex, answer, chatId);
      }

      return true;
    }

    if (parsed.optionIndex >= question.options.length) return true;

    if (question.multiSelect) {
      const updated = {
        ...sent,
        progress: toggleSelection(
          sent.progress,
          parsed.questionIndex,
          parsed.optionIndex,
        ),
      };

      saveSent(record.id, updated);
      await editQuestionMarkup(
        updated,
        parsed.questionIndex,
        buildKeyboard(
          question,
          sent.shortId,
          parsed.questionIndex,
          text,
          updated.progress.selections[parsed.questionIndex],
        ),
      );

      return true;
    }

    await finalize(
      record,
      sent,
      parsed.questionIndex,
      optionAnswer(question, parsed.optionIndex),
      chatId,
    );

    return true;
  }

  async function consumeText(chatId: string, text: string): Promise<boolean> {
    const candidates = listAskIds()
      .map((id) => ({ record: readRecord(id), sent: readSent(id) }))
      .filter(
        (
          entry,
        ): entry is {
          record: AskRecord;
          sent: SentState & { awaitingOther: number };
        } =>
          entry.record !== null &&
          entry.sent !== null &&
          !entry.sent.completed &&
          entry.sent.awaitingOther !== null,
      )
      .toSorted(
        (first, second) => second.record.createdAt - first.record.createdAt,
      );
    const latest = candidates.at(0);

    if (latest === undefined) return false;

    await finalize(
      latest.record,
      latest.sent,
      latest.sent.awaitingOther,
      otherAnswer(text),
      chatId,
    );

    return true;
  }

  return { tick, handleCallback, consumeText };
}
