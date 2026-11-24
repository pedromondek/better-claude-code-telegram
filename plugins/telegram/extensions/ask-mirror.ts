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
import { isReminderDue, questionsAwaitingConclude } from "./ask-reminder.ts";
import {
  isQuietTime,
  readDelayMinutes,
  readLocale,
  readQuietHours,
} from "./config.ts";
import { describeError, messagesFor, type Messages } from "./i18n.ts";
import type { Log } from "./log.ts";
import { toTelegramHtmlChunks } from "./telegram-html.ts";
import { conversationOnTelegram } from "./waiting-ping.ts";

interface SentMessage {
  chatId: string;
  questionIndex: number;
  messageId: number;
}

interface DeliveredMessage {
  chatId: string;
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
  touchedAt: Record<number, number>;
  movedOn: boolean;
  reminderSent: boolean;
  leftLine: number[];
}

type LaterSentFields =
  | "awaitingOther"
  | "otherPrompts"
  | "touchedAt"
  | "movedOn"
  | "reminderSent"
  | "leftLine";

interface MovedOnScope {
  chatId?: string;
  exceptShortId?: string;
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
      reply_parameters?: { message_id: number };
    },
  ): Promise<{ message_id: number }>;
  editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    options: { reply_markup: ReplyMarkup },
  ): Promise<unknown>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: { parse_mode: "HTML"; reply_markup: ReplyMarkup },
  ): Promise<unknown>;
  deleteMessage(chatId: string, messageId: number): Promise<unknown>;
}

export interface CallbackContext {
  callbackQuery?: { data?: string; message?: { message_id: number } };
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
): value is Omit<SentState, LaterSentFields> &
  Partial<Record<LaterSentFields, unknown>> {
  if (!(value instanceof Object)) return false;

  const sent = value as Partial<SentState>;

  return (
    typeof sent.shortId === "string" &&
    Array.isArray(sent.messages) &&
    typeof sent.progress === "object" &&
    sent.progress !== null
  );
}

function messagesOfQuestion(
  sent: SentState,
  questionIndex: number,
): SentMessage[] {
  return sent.messages.filter(
    (message) => message.questionIndex === questionIndex,
  );
}

function stopWaiting(awaiting: number[], questionIndex: number): number[] {
  return awaiting.filter((waiting) => waiting !== questionIndex);
}

function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function timesOf(value: unknown): Record<number, number> {
  const times: Record<number, number> = {};

  if (!(value instanceof Object)) return times;

  for (const [key, time] of Object.entries(value as Record<string, unknown>)) {
    if (typeof time === "number") times[Number(key)] = time;
  }

  return times;
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
      touchedAt: timesOf(value.touchedAt),
      movedOn: value.movedOn === true,
      reminderSent: value.reminderSent === true,
      leftLine: listOf<number>(value.leftLine),
    };
  }

  function saveSent(id: string, sent: SentState): void {
    const reminderSent =
      sent.reminderSent || (readSent(id)?.reminderSent ?? false);

    writeFileSync(sentFile(id), JSON.stringify({ ...sent, reminderSent }), {
      mode: 0o600,
    });
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
    delivered: DeliveredMessage[],
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
      delivered.push({ chatId, messageId: lastMessageId });
    }

    return lastMessageId;
  }

  async function editQuestionMarkup(
    sent: SentState,
    questionIndex: number,
    rows: KeyboardButton[][],
  ): Promise<void> {
    const text = messages();

    await Promise.all(
      messagesOfQuestion(sent, questionIndex).map((message) =>
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

  async function editQuestionText(
    record: AskRecord,
    sent: SentState,
    questionIndex: number,
    withLine: boolean,
    rows: KeyboardButton[][],
  ): Promise<void> {
    const text = messages();
    const chunks = toTelegramHtmlChunks(
      renderQuestionText(
        record.questions[questionIndex],
        questionIndex,
        record.questions.length,
        text,
        record.instance ?? null,
      ),
    );
    const lastChunk = chunks[chunks.length - 1];
    const body = withLine
      ? `${lastChunk}\n\n${text.concludeLeftLine}`
      : lastChunk;

    await Promise.all(
      messagesOfQuestion(sent, questionIndex).map((message) =>
        api
          .editMessageText(message.chatId, message.messageId, body, {
            parse_mode: "HTML",
            reply_markup: toReplyMarkup(rows),
          })
          .catch((error: unknown) =>
            log(text.askEditFailed(describeError(error))),
          ),
      ),
    );
  }

  async function settleQuestion(
    record: AskRecord,
    sent: SentState,
    questionIndex: number,
    rows: KeyboardButton[][],
  ): Promise<void> {
    if (sent.leftLine.includes(questionIndex)) {
      await editQuestionText(record, sent, questionIndex, false, rows);

      return;
    }

    await editQuestionMarkup(sent, questionIndex, rows);
  }

  async function syncConcludeLine(
    record: AskRecord,
    sent: SentState,
  ): Promise<number[]> {
    const awaiting = questionsAwaitingConclude(record.questions, sent.progress);
    const adding = awaiting.filter(
      (questionIndex) => !sent.leftLine.includes(questionIndex),
    );
    const removing = sent.leftLine.filter(
      (questionIndex) => !awaiting.includes(questionIndex),
    );
    const changed = [...adding, ...removing];
    const synced = {
      ...sent,
      leftLine: awaiting,
      movedOn: sent.movedOn && awaiting.length > 0,
    };

    saveSent(record.id, synced);
    await Promise.all(
      changed.map((questionIndex) =>
        editQuestionText(
          record,
          synced,
          questionIndex,
          adding.includes(questionIndex),
          progressKeyboard(
            record.questions[questionIndex],
            synced.shortId,
            questionIndex,
            messages(),
            synced.progress,
          ),
        ),
      ),
    );

    return changed;
  }

  async function updateSelection(
    record: AskRecord,
    sent: SentState,
    questionIndex: number,
  ): Promise<void> {
    const touched = {
      ...sent,
      touchedAt: { ...sent.touchedAt, [questionIndex]: Date.now() },
    };
    const changed = await syncConcludeLine(record, touched);

    if (changed.includes(questionIndex)) return;

    await editQuestionMarkup(
      touched,
      questionIndex,
      progressKeyboard(
        record.questions[questionIndex],
        touched.shortId,
        questionIndex,
        messages(),
        touched.progress,
      ),
    );
  }

  function markMovedOn({ chatId, exceptShortId }: MovedOnScope = {}): void {
    for (const id of listAskIds()) {
      const record = readRecord(id);
      const sent = readSent(id);

      if (
        record === null ||
        sent === null ||
        sent.completed ||
        sent.movedOn ||
        sent.shortId === exceptShortId
      ) {
        continue;
      }

      const awaiting = questionsAwaitingConclude(
        record.questions,
        sent.progress,
      ).filter(
        (questionIndex) =>
          chatId === undefined ||
          messagesOfQuestion(sent, questionIndex).some(
            (message) => message.chatId === chatId,
          ),
      );

      if (awaiting.length > 0) saveSent(id, { ...sent, movedOn: true });
    }
  }

  function allowedSender(ctx: CallbackContext): boolean {
    const senderId = ctx.from?.id;

    return senderId !== undefined && allowedChats().includes(String(senderId));
  }

  function noteTap(ctx: CallbackContext): void {
    if (allowedSender(ctx)) markMovedOn();
  }

  function shortIdOfMessage(
    chatId: string,
    messageId: number | undefined,
  ): string | undefined {
    return quotedQuestion(openAsks(), chatId, messageId, "messages")?.ask.sent
      .shortId;
  }

  function noteAnsweredTap(
    ctx: CallbackContext,
    messageId: number | undefined,
  ): void {
    if (!allowedSender(ctx)) return;

    markMovedOn({
      exceptShortId: shortIdOfMessage(String(ctx.chat?.id), messageId),
    });
  }

  async function remindConcludeLeft(
    record: AskRecord,
    sent: SentState,
    now: number,
    quiet: boolean,
  ): Promise<void> {
    const due = isReminderDue({
      questions: record.questions,
      progress: sent.progress,
      touchedAt: sent.touchedAt,
      movedOn: sent.movedOn,
      reminderSent: sent.reminderSent,
      completed: sent.completed,
      now,
      idleMs: readDelayMinutes(appDir, process.env, "reminder") * 60_000,
      quiet,
    });

    if (!due) return;

    const pending = questionsAwaitingConclude(record.questions, sent.progress);
    const reminder = messages().concludeReminder;

    saveSent(record.id, { ...sent, reminderSent: true });

    await Promise.all(
      sent.messages
        .filter((message) => pending.includes(message.questionIndex))
        .map((message) =>
          sendReply(message.chatId, reminder, message.messageId),
        ),
    );
  }

  async function deleteDelivered(delivered: DeliveredMessage[]): Promise<void> {
    await Promise.all(
      delivered.map((message) =>
        api
          .deleteMessage(message.chatId, message.messageId)
          .catch((error: unknown) =>
            log(messages().askDeleteFailed(describeError(error))),
          ),
      ),
    );
  }

  async function sendAskToChat(
    record: AskRecord,
    shortId: string,
    chatId: string,
  ): Promise<SentMessage[] | null> {
    const text = messages();
    const total = record.questions.length;
    const sentMessages: SentMessage[] = [];
    const delivered: DeliveredMessage[] = [];

    try {
      if (record.context) {
        await sendHtml(
          chatId,
          renderContextText(record.context, text),
          delivered,
        );
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
          delivered,
          buildKeyboard(question, shortId, questionIndex, text),
        );

        sentMessages.push({ chatId, questionIndex, messageId });
      }
    } catch (error) {
      log(text.askCycleFailed(describeError(error)));
      await deleteDelivered(delivered);

      return null;
    }

    return sentMessages;
  }

  async function sendAsk(record: AskRecord): Promise<void> {
    const shortId = shortIdFor(record.id);
    const sentMessages: SentMessage[] = [];
    let reachedEveryQuestion = false;

    for (const chatId of allowedChats()) {
      const chatMessages = await sendAskToChat(record, shortId, chatId);

      if (chatMessages === null) continue;

      sentMessages.push(...chatMessages);
      reachedEveryQuestion = true;
    }

    if (!reachedEveryQuestion) return;

    saveSent(record.id, {
      shortId,
      messages: sentMessages,
      progress: emptyProgress(),
      awaitingOther: [],
      otherPrompts: [],
      completed: false,
      touchedAt: {},
      movedOn: false,
      reminderSent: false,
      leftLine: [],
    });
    log(messages().askSent(record.id, record.instance ?? "telegram"));
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
        settleQuestion(
          record,
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

        if (sent) await remindConcludeLeft(record, sent, now, quiet);
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
        answers: answersByQuestion(
          record.questions,
          sent.progress,
          text.typedAnswerSuffix,
        ),
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
    const settled = {
      ...updated,
      leftLine: updated.leftLine.filter(
        (markedIndex) => markedIndex !== questionIndex,
      ),
    };

    saveSent(record.id, settled);
    await settleQuestion(record, updated, questionIndex, finalKeyboard(answer));

    if (isComplete(settled.progress, record.questions.length)) {
      await complete(record, settled, chatId);
    } else {
      await syncConcludeLine(record, settled);
    }

    markMovedOn();
  }

  async function handledAnsweredTap(ctx: CallbackContext): Promise<boolean> {
    const query = ctx.callbackQuery;

    if (query?.data !== ANSWERED_CALLBACK) return false;

    noteAnsweredTap(ctx, query.message?.message_id);
    await ctx.answerCallbackQuery().catch(() => undefined);

    return true;
  }

  async function handleCallback(ctx: CallbackContext): Promise<boolean> {
    if (await handledAnsweredTap(ctx)) return true;

    const parsed = parseAskCallback(String(ctx.callbackQuery?.data));

    if (!parsed) {
      noteTap(ctx);

      return false;
    }

    const text = messages();
    const senderId = ctx.from?.id;

    if (!allowedSender(ctx)) {
      await ctx
        .answerCallbackQuery({ text: text.notAuthorized })
        .catch(() => undefined);

      return true;
    }

    markMovedOn({ exceptShortId: parsed.shortId });

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
        touchedAt: {
          ...released.touchedAt,
          [parsed.questionIndex]: Date.now(),
        },
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
      await updateSelection(
        record,
        {
          ...sent,
          progress: toggleSelection(
            sent.progress,
            parsed.questionIndex,
            parsed.optionIndex,
          ),
        },
        parsed.questionIndex,
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
    messageId: number | undefined,
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

      await updateSelection(record, updated, questionIndex);

      return;
    }

    await finalize(
      record,
      {
        ...sent,
        progress: typeSelection(
          sent.progress,
          questionIndex,
          otherAnswer(text),
        ),
      },
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
    const consumed = await takeText(chatId, text, repliedMessageId);

    if (!consumed) markMovedOn({ chatId });

    return consumed;
  }

  async function takeText(
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

  async function sendReply(
    chatId: string,
    markdown: string,
    replyToMessageId: number,
  ): Promise<void> {
    for (const chunk of toTelegramHtmlChunks(markdown)) {
      await api
        .sendMessage(chatId, chunk, {
          parse_mode: "HTML",
          reply_parameters: { message_id: replyToMessageId },
        })
        .catch((error: unknown) =>
          log(messages().askConfirmFailed(describeError(error))),
        );
    }
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
