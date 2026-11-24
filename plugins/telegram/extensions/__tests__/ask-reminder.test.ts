import { describe, expect, it } from "vitest";

import {
  answerQuestion,
  emptyProgress,
  toggleSelection,
  typeSelection,
  type AskProgress,
  type AskQuestion,
} from "../ask-format.ts";
import {
  isReminderDue,
  questionsAwaitingConclude,
  type ReminderInput,
} from "../ask-reminder.ts";

const SINGLE: AskQuestion = {
  question: "Qual banco?",
  options: [{ label: "Postgres" }],
};
const MULTI: AskQuestion = {
  question: "Quais camadas?",
  multiSelect: true,
  options: [{ label: "Backend" }, { label: "Frontend" }],
};
const OTHER_MULTI: AskQuestion = {
  question: "Quais testes?",
  multiSelect: true,
  options: [{ label: "Unit" }],
};

const IDLE_MS = 3 * 60_000;
const INTERACTED_AT = 1_000_000;

function answered(...indexes: number[]): AskProgress {
  return indexes.reduce(
    (progress, index) => answerQuestion(progress, index, "x"),
    emptyProgress(),
  );
}

function selecting(progress: AskProgress, index: number): AskProgress {
  return toggleSelection(progress, index, 0);
}

function input(overrides: Partial<ReminderInput> = {}): ReminderInput {
  return {
    questions: [SINGLE, MULTI],
    progress: selecting(answered(0), 1),
    touchedAt: { 1: INTERACTED_AT },
    movedOn: false,
    reminderSent: false,
    completed: false,
    now: INTERACTED_AT + IDLE_MS,
    idleMs: IDLE_MS,
    quiet: false,
    ...overrides,
  };
}

describe("questionsAwaitingConclude", () => {
  it("lists the multiple choice question with a selection once the others were answered", (): void => {
    expect(
      questionsAwaitingConclude([SINGLE, MULTI], selecting(answered(0), 1)),
    ).toEqual([1]);
  });

  it("lists a lone multiple choice question that has a selection", (): void => {
    expect(
      questionsAwaitingConclude([MULTI], selecting(answered(), 0)),
    ).toEqual([0]);
  });

  it("counts typed text without any selection as awaiting Done", (): void => {
    expect(
      questionsAwaitingConclude(
        [MULTI],
        typeSelection(emptyProgress(), 0, "Mobile"),
      ),
    ).toEqual([0]);
  });

  it("lists nothing for a multiple choice with nothing selected and nothing typed", (): void => {
    expect(questionsAwaitingConclude([MULTI], emptyProgress())).toEqual([]);
    expect(questionsAwaitingConclude([SINGLE, MULTI], answered(0))).toEqual([]);
  });

  it("lists nothing when the selection was cleared again", (): void => {
    expect(
      questionsAwaitingConclude(
        [MULTI],
        toggleSelection(selecting(emptyProgress(), 0), 0, 0),
      ),
    ).toEqual([]);
  });

  it("lists nothing when the typed text is empty", (): void => {
    expect(
      questionsAwaitingConclude([MULTI], typeSelection(emptyProgress(), 0, "")),
    ).toEqual([]);
  });

  it("lists every question awaiting Done, in order", (): void => {
    const progress = selecting(selecting(answered(0), 1), 2);

    expect(
      questionsAwaitingConclude([SINGLE, MULTI, OTHER_MULTI], progress),
    ).toEqual([1, 2]);
  });

  it("lists nothing while another open multiple choice has nothing selected", (): void => {
    expect(
      questionsAwaitingConclude(
        [SINGLE, MULTI, OTHER_MULTI],
        selecting(answered(0), 1),
      ),
    ).toEqual([]);
  });

  it("lists nothing while a single choice question is still open", (): void => {
    expect(
      questionsAwaitingConclude(
        [SINGLE, MULTI, SINGLE],
        selecting(answered(0), 1),
      ),
    ).toEqual([]);
  });

  it("lists nothing once every question is answered", (): void => {
    expect(
      questionsAwaitingConclude([SINGLE, MULTI], selecting(answered(0, 1), 1)),
    ).toEqual([]);
  });

  it("lists nothing for an ask without questions", (): void => {
    expect(questionsAwaitingConclude([], answered())).toEqual([]);
  });

  it("treats a question whose multiSelect is false as a single choice", (): void => {
    expect(
      questionsAwaitingConclude(
        [{ ...MULTI, multiSelect: false }],
        selecting(answered(), 0),
      ),
    ).toEqual([]);
  });
});

describe("isReminderDue", () => {
  it("is due exactly when the idle time has passed since the last toggle", (): void => {
    expect(isReminderDue(input())).toBe(true);
  });

  it("is not due one millisecond before the idle time", (): void => {
    expect(isReminderDue(input({ now: INTERACTED_AT + IDLE_MS - 1 }))).toBe(
      false,
    );
  });

  it("is due long after the idle time", (): void => {
    expect(isReminderDue(input({ now: INTERACTED_AT + IDLE_MS * 50 }))).toBe(
      true,
    );
  });

  it("is due right away when the idle time is zero", (): void => {
    expect(isReminderDue(input({ idleMs: 0, now: INTERACTED_AT }))).toBe(true);
  });

  it("is due right away once he moved on, however recent the last toggle", (): void => {
    expect(isReminderDue(input({ movedOn: true, now: INTERACTED_AT }))).toBe(
      true,
    );
  });

  it("is not due when he moved on but nothing awaits Done", (): void => {
    expect(isReminderDue(input({ movedOn: true, progress: answered(0) }))).toBe(
      false,
    );
    expect(
      isReminderDue(input({ movedOn: true, progress: answered(0, 1) })),
    ).toBe(false);
  });

  it("is due when any question awaiting Done has been idle long enough", (): void => {
    expect(
      isReminderDue(
        input({
          questions: [SINGLE, MULTI, OTHER_MULTI],
          progress: selecting(selecting(answered(0), 1), 2),
          touchedAt: { 1: INTERACTED_AT, 2: INTERACTED_AT + IDLE_MS },
          now: INTERACTED_AT + IDLE_MS,
        }),
      ),
    ).toBe(true);
  });

  it("is not due while every question awaiting Done was touched recently", (): void => {
    expect(
      isReminderDue(
        input({
          questions: [SINGLE, MULTI, OTHER_MULTI],
          progress: selecting(selecting(answered(0), 1), 2),
          touchedAt: { 1: INTERACTED_AT + 1, 2: INTERACTED_AT + 1 },
          now: INTERACTED_AT + IDLE_MS,
        }),
      ),
    ).toBe(false);
  });

  it("ignores the time of a question that does not await Done", (): void => {
    expect(
      isReminderDue(input({ touchedAt: { 0: INTERACTED_AT - IDLE_MS * 9 } })),
    ).toBe(false);
  });

  it("is due for a lone multiple choice that has a selection", (): void => {
    expect(
      isReminderDue(
        input({
          questions: [MULTI],
          progress: selecting(emptyProgress(), 0),
          touchedAt: { 0: INTERACTED_AT },
        }),
      ),
    ).toBe(true);
  });

  it("is not due when the reminder was already sent", (): void => {
    expect(isReminderDue(input({ reminderSent: true }))).toBe(false);
    expect(isReminderDue(input({ reminderSent: true, movedOn: true }))).toBe(
      false,
    );
  });

  it("is not due during quiet hours", (): void => {
    expect(isReminderDue(input({ quiet: true }))).toBe(false);
    expect(isReminderDue(input({ quiet: true, movedOn: true }))).toBe(false);
  });

  it("is not due once the ask is completed", (): void => {
    expect(isReminderDue(input({ completed: true }))).toBe(false);
    expect(isReminderDue(input({ completed: true, movedOn: true }))).toBe(
      false,
    );
  });

  it("is not due when the state has no time of the last toggle", (): void => {
    expect(isReminderDue(input({ touchedAt: {} }))).toBe(false);
  });

  it("is not due while a single choice question is still open", (): void => {
    expect(
      isReminderDue(
        input({
          questions: [SINGLE, MULTI, SINGLE],
          progress: selecting(answered(0), 1),
        }),
      ),
    ).toBe(false);
  });

  it("is not due for a multiple choice with nothing selected", (): void => {
    expect(isReminderDue(input({ progress: answered(0) }))).toBe(false);
  });

  it("is not due when every question is answered", (): void => {
    expect(isReminderDue(input({ progress: answered(0, 1) }))).toBe(false);
  });
});
