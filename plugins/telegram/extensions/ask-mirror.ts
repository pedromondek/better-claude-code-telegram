import {
  chmodSync,
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
  progressAnswer,
  progressKeyboard,
  renderContextText,
  renderQuestionText,
  shortIdFor,
  toggleSelection,
  typeSelection,
  typedAnswer,
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

interface ClosedRequest {
  chatId: string;
  messageId: number;
  questionNumber: number;
  header: string | null;
  closedAt: number;
}

interface SentState {
  shortId: string;
  messages: SentMessage[];
  progress: AskProgress;
  awaitingOther: number[];
  otherPrompts: SentMessage[];
  completed: boolean;
}

interface OpenAsk {
  record: AskRecord;
  sent: SentState;
}

interface ReplyMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

interface ForceReplyMarkup {
  force_reply: true;
}

interface BotApi {
  sendMessage(
    chatId: string,
    text: string,
    options?: {
      reply_markup?: ReplyMarkup | ForceReplyMarkup;
      parse_mode?: "HTML";
    },
  ): Promise<{ message_id: number }>;
  editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    options: { reply_markup: ReplyMarkup },
  ): Promise<unknown>;
  deleteMessage(chatId: string, messageId: number): Promise<unknown>;
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
  held: () => number;
  handleCallback: (ctx: CallbackContext) => Promise<boolean>;
  consumeText: (
    chatId: string,
    text: string,
    repliedMessageId?: number,
  ) => Promise<boolean>;
}

export const SENT_SUFFIX = ".telegram.json";
export const ANSWER_SUFFIX = ".answer.json";
export const CLOSED_REQUESTS_FILE = "closed-other-requests.json";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;

function isClosedRequest(value: unknown): value is ClosedRequest {
  if (!(value instanceof Object)) return false;

  const request = value as Partial<ClosedRequest>;

  return (
    typeof request.chatId === "string" &&
    typeof request.messageId === "number" &&
    typeof request.questionNumber === "number" &&
    typeof request.closedAt === "number"
  );
}

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

function isSentState(
  value: unknown,
): value is Omit<SentState, "awaitingOther" | "otherPrompts"> &
  Partial<Record<"awaitingOther" | "otherPrompts", unknown>> {
  if (!(value instanceof Object)) return false;

  const sent = value as Partial<SentState>;

  return (
    typeof sent.shortId === "string" &&
    Array.isArray(sent.messages) &&
    typeof sent.progress === "object" &&
    sent.progress !== null
  );
}

function stopWaiting(awaiting: number[], questionIndex: number): number[] {
  return awaiting.filter((waiting) => waiting !== questionIndex);
}

function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
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
  const closedRequestsFile = join(appDir, CLOSED_REQUESTS_FILE);

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

    if (!isSentState(value)) return null;

    return {
      ...value,
      awaitingOther: listOf<number>(value.awaitingOther),
      otherPrompts: listOf<SentMessage>(value.otherPrompts),
    };
  }

  function saveSent(id: string, sent: SentState): void {
    writeFileSync(sentFile(id), JSON.stringify(sent), { mode: 0o600 });
  }

  function removeAsk(id: string): void {
    for (const file of [recordFile(id), sentFile(id), closedFile(id)]) {
      rmSync(file, { force: true });
    }
  }

  function readClosedRequests(now: number): ClosedRequest[] {
    return listOf<unknown>(readJson(closedRequestsFile))
      .filter(isClosedRequest)
      .filter((request) => now - request.closedAt <= DELETE_WINDOW_MS);
  }

  function recordClosedRequests(
    record: AskRecord,
    requests: SentMessage[],
  ): void {
    if (requests.length === 0) return;

    const now = Date.now();
    const closed = requests.map((request) => ({
      chatId: request.chatId,
      messageId: request.messageId,
      questionNumber: request.questionIndex + 1,
      header: record.questions[request.questionIndex].header ?? null,
      closedAt: now,
    }));

    writeFileSync(
      closedRequestsFile,
      JSON.stringify([...readClosedRequests(now), ...closed]),
    );
    chmodSync(closedRequestsFile, 0o600);
  }

  async function releaseRequests(
    sent: SentState,
    matches: (request: SentMessage) => boolean,
  ): Promise<SentState> {
    const kept: SentMessage[] = [];

    for (const request of sent.otherPrompts) {
      if (!matches(request)) {
        kept.push(request);
        continue;
      }

      await api
        .deleteMessage(request.chatId, request.messageId)
        .catch((error: unknown) => {
          log(messages().askDeleteFailed(describeError(error)));
          kept.push(request);
        });
    }

    return { ...sent, otherPrompts: kept };
  }

  async function closeRequests(
    record: AskRecord,
    sent: SentState | null,
  ): Promise<void> {
    if (sent === null) return;

    const released = await releaseRequests(sent, () => true);

    recordClosedRequests(record, released.otherPrompts);
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
      try {
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
      } catch (error) {
        log(text.askCycleFailed(describeError(error)));
      }
    }

    if (sentMessages.length === 0) return;

    saveSent(record.id, {
      shortId,
      messages: sentMessages,
      progress: emptyProgress(),
      awaitingOther: [],
      otherPrompts: [],
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

          await closeRequests(record, sent);
          removeAsk(id);
          rmSync(answerFile(id), { force: true });
          continue;
        }

        if (now - record.createdAt > MAX_AGE_MS) {
          await closeRequests(record, sent);
          removeAsk(id);
          rmSync(answerFile(id), { force: true });
          continue;
        }

        const due = (now >= record.dueAt || onTelegram) && !quiet;

        if (!sent && (record.released === true || due)) {
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
    saveSent(record.id, { ...sent, completed: true });

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
    const updated = await releaseRequests(
      {
        ...sent,
        progress: answerQuestion(sent.progress, questionIndex, answer),
        awaitingOther: stopWaiting(sent.awaitingOther, questionIndex),
      },
      (request) => request.questionIndex === questionIndex,
    );

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
      const released = await releaseRequests(
        sent,
        (request) => request.questionIndex === parsed.questionIndex,
      );
      const prompt = await api.sendMessage(
        chatId,
        text.writeOtherAnswer(
          parsed.questionIndex + 1,
          question.header ?? null,
          sent.progress.typed?.[parsed.questionIndex] ?? null,
        ),
        { reply_markup: { force_reply: true } },
      );

      saveSent(record.id, {
        ...released,
        awaitingOther: [
          ...stopWaiting(sent.awaitingOther, parsed.questionIndex),
          parsed.questionIndex,
        ],
        otherPrompts: [
          ...released.otherPrompts,
          {
            chatId,
            questionIndex: parsed.questionIndex,
            messageId: prompt.message_id,
          },
        ],
      });

      return true;
    }

    if (parsed.action === "done") {
      const answer = progressAnswer(
        question,
        sent.progress,
        parsed.questionIndex,
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
        progressKeyboard(
          question,
          sent.shortId,
          parsed.questionIndex,
          text,
          updated.progress,
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

  function openAsks(): OpenAsk[] {
    return listAskIds()
      .map((id) => ({ record: readRecord(id), sent: readSent(id) }))
      .filter(
        (entry): entry is OpenAsk =>
          entry.record !== null && entry.sent !== null && !entry.sent.completed,
      )
      .toSorted(
        (first, second) => second.record.createdAt - first.record.createdAt,
      );
  }

  function quotedQuestion(
    asks: OpenAsk[],
    chatId: string,
    messageId: number,
    list: "messages" | "otherPrompts",
  ): { ask: OpenAsk; questionIndex: number } | null {
    for (const ask of asks) {
      const quoted = ask.sent[list].find(
        (message) =>
          message.chatId === chatId && message.messageId === messageId,
      );

      if (quoted) return { ask, questionIndex: quoted.questionIndex };
    }

    return null;
  }

  async function answerTyped(
    { record, sent }: OpenAsk,
    questionIndex: number,
    text: string,
    chatId: string,
  ): Promise<void> {
    const question = record.questions[questionIndex];

    if (question.multiSelect) {
      const typed = otherAnswer(text);
      const updated = await releaseRequests(
        {
          ...sent,
          progress:
            typed === ""
              ? sent.progress
              : typeSelection(sent.progress, questionIndex, typed),
          awaitingOther: stopWaiting(sent.awaitingOther, questionIndex),
        },
        (request) => request.questionIndex === questionIndex,
      );

      saveSent(record.id, updated);
      await editQuestionMarkup(
        updated,
        questionIndex,
        progressKeyboard(
          question,
          sent.shortId,
          questionIndex,
          messages(),
          updated.progress,
        ),
      );

      return;
    }

    await finalize(
      record,
      sent,
      questionIndex,
      typedAnswer(
        question,
        sent.progress.selections[questionIndex] ?? [],
        text,
      ),
      chatId,
    );
  }

  async function consumeText(
    chatId: string,
    text: string,
    repliedMessageId?: number,
  ): Promise<boolean> {
    const asks = openAsks();

    if (repliedMessageId !== undefined) {
      const quoted = quotedQuestion(
        asks,
        chatId,
        repliedMessageId,
        "otherPrompts",
      );

      if (quoted === null) {
        const question = quotedQuestion(
          asks,
          chatId,
          repliedMessageId,
          "messages",
        );

        if (question !== null) {
          if (
            question.ask.sent.progress.answers[question.questionIndex] ===
            undefined
          ) {
            await noticeNeedsPrompt(
              question.ask,
              question.questionIndex,
              chatId,
            );
          }

          return false;
        }

        const closed = closedRequest(chatId, repliedMessageId);

        if (closed !== null) {
          await sendNotice(
            chatId,
            messages().otherQuestionClosed(
              closed.questionNumber,
              closed.header,
            ),
          );
        }

        return false;
      }

      const { ask, questionIndex } = quoted;
      const answered = ask.sent.progress.answers[questionIndex];

      if (answered === undefined) {
        await answerTyped(ask, questionIndex, text, chatId);

        return true;
      }

      await api
        .sendMessage(
          chatId,
          messages().otherAlreadyAnswered(
            questionIndex + 1,
            ask.record.questions[questionIndex].header ?? null,
            answered,
          ),
        )
        .catch((error: unknown) =>
          log(messages().askConfirmFailed(describeError(error))),
        );

      return true;
    }

    const chosen = asks
      .flatMap((ask) =>
        ask.sent.awaitingOther
          .toReversed()
          .filter((questionIndex) =>
            ask.sent.otherPrompts.some(
              (prompt) =>
                prompt.chatId === chatId &&
                prompt.questionIndex === questionIndex,
            ),
          )
          .map((questionIndex) => ({ ask, questionIndex })),
      )
      .at(0);

    if (chosen !== undefined) {
      await noticeNeedsPrompt(chosen.ask, chosen.questionIndex, chatId);
    }

    return false;
  }

  function closedRequest(
    chatId: string,
    messageId: number,
  ): Pick<ClosedRequest, "questionNumber" | "header"> | null {
    const isRequest = (request: {
      chatId: string;
      messageId: number;
    }): boolean => request.chatId === chatId && request.messageId === messageId;

    for (const id of listAskIds()) {
      const sent = readSent(id);
      const record = readRecord(id);
      const request = sent?.otherPrompts.find(isRequest);

      if (record && request) {
        return {
          questionNumber: request.questionIndex + 1,
          header: record.questions[request.questionIndex].header ?? null,
        };
      }
    }

    return readClosedRequests(Date.now()).find(isRequest) ?? null;
  }

  async function sendNotice(chatId: string, text: string): Promise<void> {
    await api
      .sendMessage(chatId, text)
      .catch((error: unknown) =>
        log(messages().askConfirmFailed(describeError(error))),
      );
  }

  async function noticeNeedsPrompt(
    { record, sent }: OpenAsk,
    questionIndex: number,
    chatId: string,
  ): Promise<void> {
    saveSent(record.id, {
      ...sent,
      awaitingOther: stopWaiting(sent.awaitingOther, questionIndex),
    });

    await api
      .sendMessage(
        chatId,
        messages().otherNeedsPrompt(
          questionIndex + 1,
          record.questions[questionIndex].header ?? null,
        ),
      )
      .catch((error: unknown) =>
        log(messages().askConfirmFailed(describeError(error))),
      );
  }

  function held(): number {
    const now = Date.now();
    const onTelegram = conversationOnTelegram(appDir);

    return listAskIds().filter((id) => {
      const record = readRecord(id);

      return (
        record !== null &&
        readSent(id) === null &&
        !existsSync(closedFile(id)) &&
        now - record.createdAt <= MAX_AGE_MS &&
        (record.released === true || now >= record.dueAt || onTelegram)
      );
    }).length;
  }

  return { tick, held, handleCallback, consumeText };
}
