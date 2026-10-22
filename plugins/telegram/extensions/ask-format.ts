import { createHash } from "node:crypto";

import type { Messages } from "./i18n.ts";

export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface AskRecord {
  id: string;
  sessionId: string | null;
  createdAt: number;
  dueAt: number;
  instance?: string | null;
  context?: string | null;
  questions: AskQuestion[];
}

export type AskCallback =
  | {
      shortId: string;
      questionIndex: number;
      action: "option";
      optionIndex: number;
    }
  | { shortId: string; questionIndex: number; action: "other" }
  | { shortId: string; questionIndex: number; action: "done" };

export interface KeyboardButton {
  text: string;
  data: string;
}

export interface AskProgress {
  answers: Record<number, string>;
  selections: Record<number, number[]>;
}

export const ANSWERED_CALLBACK = "ask:answered";

const CALLBACK_PATTERN = /^ask:([0-9a-f]{8}):(\d{1,2}):(o|d|\d{1,2})$/;
const MAX_BUTTON_TEXT_LENGTH = 64;

export function shortIdFor(askId: string): string {
  return createHash("sha1").update(askId).digest("hex").slice(0, 8);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function renderContextText(context: string, messages: Messages): string {
  return messages.contextText(context);
}

export function renderQuestionText(
  question: AskQuestion,
  index: number,
  total: number,
  messages: Messages,
  instance: string | null = null,
): string {
  const counter = total > 1 ? ` (${index + 1}/${total})` : "";
  const lines = [`${messages.questionTitle(instance)}${counter}`];

  if (question.header) lines.push(`[${question.header}]`);

  lines.push(question.question, "");

  question.options.forEach((option, optionIndex) => {
    lines.push(`${optionIndex + 1}. ${option.label}`);

    if (option.description) lines.push(`   ${option.description}`);

    if (option.preview) {
      lines.push(
        `   ${messages.previewLabel}`,
        "```",
        ...option.preview.split("\n"),
        "```",
      );
    }

    lines.push("");
  });

  if (question.multiSelect) lines.push(messages.multiSelectHint);

  lines.push(messages.otherHint);

  return lines.join("\n");
}

export function buildKeyboard(
  question: AskQuestion,
  shortId: string,
  questionIndex: number,
  messages: Messages,
  selected?: number[],
): KeyboardButton[][] {
  const optionRows = question.options.map((option, optionIndex) => {
    const mark = selected?.includes(optionIndex) ? "☑️ " : "";

    return [
      {
        text: truncate(
          `${mark}${optionIndex + 1}. ${option.label}`,
          MAX_BUTTON_TEXT_LENGTH,
        ),
        data: `ask:${shortId}:${questionIndex}:${optionIndex}`,
      },
    ];
  });
  const extraRows = [
    [
      {
        text: messages.otherButton,
        data: `ask:${shortId}:${questionIndex}:o`,
      },
    ],
  ];

  if (question.multiSelect)
    extraRows.push([
      { text: messages.doneButton, data: `ask:${shortId}:${questionIndex}:d` },
    ]);

  return [...optionRows, ...extraRows];
}

export function finalKeyboard(answer: string): KeyboardButton[][] {
  return [
    [
      {
        text: truncate(`✅ ${answer}`, MAX_BUTTON_TEXT_LENGTH),
        data: ANSWERED_CALLBACK,
      },
    ],
  ];
}

export function parseAskCallback(data: string): AskCallback | null {
  const match = CALLBACK_PATTERN.exec(data);

  if (!match) return null;

  const [, shortId, questionText, actionText] = match;
  const questionIndex = Number(questionText);

  if (actionText === "o") return { shortId, questionIndex, action: "other" };
  if (actionText === "d") return { shortId, questionIndex, action: "done" };

  return {
    shortId,
    questionIndex,
    action: "option",
    optionIndex: Number(actionText),
  };
}

export function emptyProgress(): AskProgress {
  return { answers: {}, selections: {} };
}

export function toggleSelection(
  progress: AskProgress,
  questionIndex: number,
  optionIndex: number,
): AskProgress {
  const current = progress.selections[questionIndex] ?? [];
  const next = current.includes(optionIndex)
    ? current.filter((selectedIndex) => selectedIndex !== optionIndex)
    : [...current, optionIndex].toSorted((first, second) => first - second);

  return {
    ...progress,
    selections: { ...progress.selections, [questionIndex]: next },
  };
}

export function answerQuestion(
  progress: AskProgress,
  questionIndex: number,
  answer: string,
): AskProgress {
  return {
    ...progress,
    answers: { ...progress.answers, [questionIndex]: answer },
  };
}

export function optionAnswer(
  question: AskQuestion,
  optionIndex: number,
): string {
  return question.options[optionIndex].label;
}

export function selectionAnswer(
  question: AskQuestion,
  selected: number[],
): string | null {
  if (selected.length === 0) return null;

  return selected
    .map((optionIndex) => question.options[optionIndex].label)
    .join(", ");
}

export function otherAnswer(text: string): string {
  return text.trim();
}

export function isAnswered(
  progress: AskProgress,
  questionIndex: number,
): boolean {
  return progress.answers[questionIndex] !== undefined;
}

export function isComplete(progress: AskProgress, total: number): boolean {
  return Array.from({ length: total }, (_, index) => index).every((index) =>
    isAnswered(progress, index),
  );
}

export function answersByQuestion(
  questions: AskQuestion[],
  progress: AskProgress,
): Record<string, string> {
  return Object.fromEntries(
    questions.map((question, index) => [
      question.question,
      progress.answers[index] ?? "",
    ]),
  );
}

export function isAskRecord(value: unknown): value is AskRecord {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Partial<AskRecord>;

  return (
    typeof record.id === "string" &&
    typeof record.dueAt === "number" &&
    Array.isArray(record.questions) &&
    record.questions.every(
      (question) =>
        typeof question?.question === "string" &&
        Array.isArray(question.options),
    )
  );
}
