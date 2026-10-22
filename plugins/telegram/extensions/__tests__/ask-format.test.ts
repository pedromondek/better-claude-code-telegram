import { describe, expect, it } from "vitest";

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
  type AskQuestion,
} from "../ask-format.ts";
import { MESSAGES } from "../i18n.ts";

const PT = MESSAGES["pt-br"];
const EN = MESSAGES["en-us"];

const SINGLE: AskQuestion = {
  question: "Qual banco usar?",
  header: "Banco",
  options: [
    { label: "Postgres", description: "Relacional" },
    { label: "Redis", preview: "linha 1\nlinha 2" },
  ],
};

const MULTI: AskQuestion = {
  question: "Quais camadas?",
  multiSelect: true,
  options: [{ label: "Backend" }, { label: "Frontend" }, { label: "Infra" }],
};

describe("shortIdFor", () => {
  it("generates 8 stable hex chars for the same request", (): void => {
    expect(shortIdFor("toolu_1")).toMatch(/^[0-9a-f]{8}$/);
    expect(shortIdFor("toolu_1")).toBe(shortIdFor("toolu_1"));
    expect(shortIdFor("toolu_1")).not.toBe(shortIdFor("toolu_2"));
  });
});

describe("renderQuestionText in pt-br", () => {
  it("shows counter, header, options with description and preview and the other-answer hint", (): void => {
    expect(renderQuestionText(SINGLE, 0, 2, PT)).toBe(
      [
        "❓ Pergunta aberta no terminal (1/2)",
        "[Banco]",
        "Qual banco usar?",
        "",
        "1. Postgres",
        "   Relacional",
        "",
        "2. Redis",
        "   Prévia:",
        "```",
        "linha 1",
        "linha 2",
        "```",
        "",
        "✍️ Outra resposta: toque no botão e escreva a resposta aqui no chat.",
      ].join("\n"),
    );
  });

  it("omits the counter with a single question and explains multiple choice", (): void => {
    const text = renderQuestionText(MULTI, 0, 1, PT);

    expect(
      text.startsWith("❓ Pergunta aberta no terminal\nQuais camadas?"),
    ).toBe(true);
    expect(
      text.includes(
        "Escolha múltipla: toque em todas que quiser e depois em ✅ Concluir.",
      ),
    ).toBe(true);
  });

  it("says which instance the question came from", (): void => {
    expect(renderQuestionText(SINGLE, 1, 2, PT, "back-s3").split("\n")[0]).toBe(
      "❓ Pergunta aberta no terminal de [back-s3] (2/2)",
    );
  });

  it("keeps the whole preview, uncut", (): void => {
    const text = renderQuestionText(
      { question: "Q", options: [{ label: "A", preview: "x".repeat(2000) }] },
      0,
      1,
      PT,
    );

    expect(text.includes(`\`\`\`\n${"x".repeat(2000)}\n\`\`\``)).toBe(true);
    expect(text.includes("…")).toBe(false);
  });
});

describe("renderQuestionText in en-us", () => {
  it("shows counter, header, options with description and preview and the other-answer hint", (): void => {
    expect(renderQuestionText(SINGLE, 0, 2, EN)).toBe(
      [
        "❓ Question open in the terminal (1/2)",
        "[Banco]",
        "Qual banco usar?",
        "",
        "1. Postgres",
        "   Relacional",
        "",
        "2. Redis",
        "   Preview:",
        "```",
        "linha 1",
        "linha 2",
        "```",
        "",
        "✍️ Other answer: tap the button and type your answer here in the chat.",
      ].join("\n"),
    );
  });

  it("omits the counter with a single question and explains multiple choice", (): void => {
    const text = renderQuestionText(MULTI, 0, 1, EN);

    expect(
      text.startsWith("❓ Question open in the terminal\nQuais camadas?"),
    ).toBe(true);
    expect(
      text.includes(
        "Multiple choice: tap every option you want, then ✅ Done.",
      ),
    ).toBe(true);
  });

  it("says which instance the question came from", (): void => {
    expect(renderQuestionText(SINGLE, 1, 2, EN, "back-s3").split("\n")[0]).toBe(
      "❓ Question open in the terminal from [back-s3] (2/2)",
    );
  });
});

describe("renderContextText", () => {
  it("explains where the context comes from in pt-br", (): void => {
    expect(renderContextText("Estou migrando o banco.", PT)).toBe(
      "📝 Contexto (o que o Claude escreveu no terminal antes da pergunta):\n\nEstou migrando o banco.",
    );
  });

  it("explains where the context comes from in en-us", (): void => {
    expect(renderContextText("I am migrating the database.", EN)).toBe(
      "📝 Context (what Claude wrote in the terminal before the question):\n\nI am migrating the database.",
    );
  });
});

describe("buildKeyboard", () => {
  it("single choice in pt-br: one row per option and the other answer, no done", (): void => {
    expect(buildKeyboard(SINGLE, "abcdef01", 0, PT)).toEqual([
      [{ text: "1. Postgres", data: "ask:abcdef01:0:0" }],
      [{ text: "2. Redis", data: "ask:abcdef01:0:1" }],
      [{ text: "✍️ Outra resposta (escrever)", data: "ask:abcdef01:0:o" }],
    ]);
  });

  it("multiple choice in pt-br: marks the selected and adds done", (): void => {
    expect(buildKeyboard(MULTI, "abcdef01", 1, PT, [2])).toEqual([
      [{ text: "1. Backend", data: "ask:abcdef01:1:0" }],
      [{ text: "2. Frontend", data: "ask:abcdef01:1:1" }],
      [{ text: "☑️ 3. Infra", data: "ask:abcdef01:1:2" }],
      [{ text: "✍️ Outra resposta (escrever)", data: "ask:abcdef01:1:o" }],
      [{ text: "✅ Concluir", data: "ask:abcdef01:1:d" }],
    ]);
  });

  it("single choice in en-us: one row per option and the other answer, no done", (): void => {
    expect(buildKeyboard(SINGLE, "abcdef01", 0, EN)).toEqual([
      [{ text: "1. Postgres", data: "ask:abcdef01:0:0" }],
      [{ text: "2. Redis", data: "ask:abcdef01:0:1" }],
      [{ text: "✍️ Other answer (type it)", data: "ask:abcdef01:0:o" }],
    ]);
  });

  it("multiple choice in en-us: marks the selected and adds done", (): void => {
    expect(buildKeyboard(MULTI, "abcdef01", 1, EN, [0, 2])).toEqual([
      [{ text: "☑️ 1. Backend", data: "ask:abcdef01:1:0" }],
      [{ text: "2. Frontend", data: "ask:abcdef01:1:1" }],
      [{ text: "☑️ 3. Infra", data: "ask:abcdef01:1:2" }],
      [{ text: "✍️ Other answer (type it)", data: "ask:abcdef01:1:o" }],
      [{ text: "✅ Done", data: "ask:abcdef01:1:d" }],
    ]);
  });

  it("fits Telegram's 64-byte callback_data", (): void => {
    const rows = buildKeyboard(MULTI, "abcdef01", 99, PT);

    expect(
      rows.flat().every((button) => Buffer.byteLength(button.data) <= 64),
    ).toBe(true);
  });

  it("cuts the button text past 64 characters with an ellipsis", (): void => {
    const rows = buildKeyboard(
      {
        question: "Q",
        options: [{ label: "x".repeat(61) }, { label: "y".repeat(62) }],
      },
      "abcdef01",
      0,
      PT,
    );

    expect(rows.slice(0, 2).map(([button]) => button.text)).toEqual([
      `1. ${"x".repeat(61)}`,
      `2. ${"y".repeat(60)}…`,
    ]);
  });
});

describe("finalKeyboard", () => {
  it("replaces the buttons with a single one holding the answer", (): void => {
    expect(finalKeyboard("1. Postgres")).toEqual([
      [{ text: "✅ 1. Postgres", data: ANSWERED_CALLBACK }],
    ]);
  });
});

describe("parseAskCallback", () => {
  it("reads option, other answer and done", (): void => {
    expect(parseAskCallback("ask:abcdef01:0:1")).toEqual({
      shortId: "abcdef01",
      questionIndex: 0,
      action: "option",
      optionIndex: 1,
    });
    expect(parseAskCallback("ask:abcdef01:2:o")).toEqual({
      shortId: "abcdef01",
      questionIndex: 2,
      action: "other",
    });
    expect(parseAskCallback("ask:abcdef01:2:d")).toEqual({
      shortId: "abcdef01",
      questionIndex: 2,
      action: "done",
    });
  });

  it("ignores what is not from the mirror, including the permission buttons", (): void => {
    expect(parseAskCallback("perm:allow:abcde")).toBeNull();
    expect(parseAskCallback("ask:XYZ:0:1")).toBeNull();
    expect(parseAskCallback(ANSWERED_CALLBACK)).toBeNull();
  });
});

describe("answer progress", () => {
  it("toggles the multiple-choice selection in order", (): void => {
    const once = toggleSelection(emptyProgress(), 0, 2);
    const twice = toggleSelection(once, 0, 0);

    expect(twice.selections[0]).toEqual([0, 2]);
    expect(toggleSelection(twice, 0, 2).selections[0]).toEqual([0]);
  });

  it("formats the option, selection and other answers", (): void => {
    expect(optionAnswer(SINGLE, 1)).toBe("Redis");
    expect(selectionAnswer(MULTI, [0, 2])).toBe("Backend, Infra");
    expect(selectionAnswer(MULTI, [])).toBeNull();
    expect(otherAnswer("  MySQL  ")).toBe("MySQL");
  });

  it("is complete only with every question answered", (): void => {
    const first = answerQuestion(emptyProgress(), 0, "1. Postgres");

    expect(isAnswered(first, 0)).toBe(true);
    expect(isComplete(first, 2)).toBe(false);
    expect(isComplete(answerQuestion(first, 1, "Backend"), 2)).toBe(true);
  });
});

describe("answersByQuestion", () => {
  it("maps each question text to its answer, in the terminal format", (): void => {
    const progress = answerQuestion(
      answerQuestion(emptyProgress(), 0, "Postgres"),
      1,
      "Backend, Infra",
    );

    expect(answersByQuestion([SINGLE, MULTI], progress)).toEqual({
      "Qual banco usar?": "Postgres",
      "Quais camadas?": "Backend, Infra",
    });
  });

  it("gives an empty answer to a question left unanswered", (): void => {
    expect(
      answersByQuestion(
        [SINGLE, MULTI],
        answerQuestion(emptyProgress(), 0, "Postgres"),
      ),
    ).toEqual({ "Qual banco usar?": "Postgres", "Quais camadas?": "" });
  });
});

describe("isAskRecord", () => {
  it("accepts the request written by the hook and rejects junk", (): void => {
    expect(isAskRecord({ id: "a", dueAt: 1, questions: [SINGLE] })).toBe(true);
    expect(
      isAskRecord({ id: "a", dueAt: 1, questions: [{ options: [] }] }),
    ).toBe(false);
    expect(isAskRecord(null)).toBe(false);
  });

  it("rejects a request missing any required field", (): void => {
    expect(isAskRecord({ dueAt: 1, questions: [SINGLE] })).toBe(false);
    expect(isAskRecord({ id: "a", questions: [SINGLE] })).toBe(false);
    expect(isAskRecord({ id: "a", dueAt: 1, questions: {} })).toBe(false);
  });

  it("rejects a request with any broken question", (): void => {
    expect(
      isAskRecord({ id: "a", dueAt: 1, questions: [SINGLE, { options: [] }] }),
    ).toBe(false);
    expect(isAskRecord({ id: "a", dueAt: 1, questions: [null] })).toBe(false);
  });

  it("rejects a value that is not an object even with the fields", (): void => {
    expect(
      isAskRecord(
        Object.assign((): void => undefined, {
          id: "a",
          dueAt: 1,
          questions: [SINGLE],
        }),
      ),
    ).toBe(false);
  });
});
