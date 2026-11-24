import {
  isAnswered,
  type AskProgress,
  type AskQuestion,
} from "./ask-format.ts";

export interface ReminderInput {
  questions: AskQuestion[];
  progress: AskProgress;
  touchedAt: Record<number, number>;
  movedOn: boolean;
  reminderSent: boolean;
  completed: boolean;
  now: number;
  idleMs: number;
  quiet: boolean;
}

function isAwaitingDone(
  question: AskQuestion,
  progress: AskProgress,
  questionIndex: number,
): boolean {
  const hasSelection = (progress.selections[questionIndex] ?? []).length > 0;
  const hasTyped = (progress.typed?.[questionIndex] ?? "") !== "";

  return question.multiSelect === true && (hasSelection || hasTyped);
}

export function questionsAwaitingConclude(
  questions: AskQuestion[],
  progress: AskProgress,
): number[] {
  const open = questions
    .map((_, questionIndex) => questionIndex)
    .filter((questionIndex) => !isAnswered(progress, questionIndex));
  const everyOpenAwaitsDone = open.every((questionIndex) =>
    isAwaitingDone(questions[questionIndex], progress, questionIndex),
  );

  return everyOpenAwaitsDone ? open : [];
}

export function isReminderDue({
  questions,
  progress,
  touchedAt,
  movedOn,
  reminderSent,
  completed,
  now,
  idleMs,
  quiet,
}: ReminderInput): boolean {
  if (completed || reminderSent || quiet) return false;

  const awaiting = questionsAwaitingConclude(questions, progress);

  return (
    awaiting.length > 0 &&
    (movedOn ||
      awaiting.some(
        (questionIndex) =>
          now - (touchedAt[questionIndex] ?? Infinity) >= idleMs,
      ))
  );
}
