import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGES,
  describeError,
  isLocale,
  messagesFor,
  type Locale,
} from "../i18n.ts";

const FUNCTION_CALLS: Record<string, unknown[]> = {
  contextText: ["ctx-sample"],
  questionTitle: ["inst-sample"],
  writeOtherAnswer: [2, "header-sample", "typed-sample"],
  otherNeedsPrompt: [2, "header-sample"],
  quietStarted: ["end-sample"],
  quietEnded: [{ questions: 1, notices: 2, permissions: 0 }],
  quietNoticeFailed: ["err-sample"],
  otherAlreadyAnswered: [1, "header-sample", "answer-sample"],
  askEditFailed: ["err-sample"],
  askSent: ["ask-sample", "inst-sample"],
  askAnsweredInTerminal: ["ask-sample"],
  askCycleFailed: ["err-sample"],
  askAnswersDelivered: ["ask-sample"],
  askConfirmFailed: ["err-sample"],
  waitingWho: ["inst-sample"],
  waitingPing: ["who-sample", "3 min", "text-sample"],
  pingFailed: ["err-sample"],
  pingSent: ["inst-sample"],
  permissionSentNow: ["req-sample"],
  permissionResolvedInTerminal: ["req-sample"],
  permissionSent: ["req-sample"],
  transcriptionText: ["text-sample"],
  transcribed: ["small", "text-sample"],
  transcriptionFailed: ["err-sample"],
  replyHeader: [true],
  mermaidUsage: ["cmd-sample"],
  mermaidFailed: ["out-sample.png"],
};

function entriesOf(locale: Locale): [string, unknown][] {
  return Object.entries(MESSAGES[locale]);
}

function byKey(first: [string, unknown], second: [string, unknown]): number {
  return first[0].localeCompare(second[0]);
}

function functionKeys(locale: Locale): string[] {
  return entriesOf(locale)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
    .toSorted();
}

function callMessage(locale: Locale, key: string): string {
  const value: unknown = Object.fromEntries(entriesOf(locale))[key];

  if (typeof value !== "function") throw new Error(`${key} is not a function`);

  const result: unknown = Reflect.apply(value, undefined, FUNCTION_CALLS[key]);

  if (typeof result !== "string") throw new Error(`${key} did not return text`);

  return result;
}

describe("LOCALES and DEFAULT_LOCALE", () => {
  it("lists en-us and pt-br in this order", (): void => {
    expect(LOCALES).toEqual(["en-us", "pt-br"]);
  });

  it("defaults to en-us, which is one of the LOCALES", (): void => {
    expect(DEFAULT_LOCALE).toBe("en-us");
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("has one MESSAGES catalog per entry of LOCALES", (): void => {
    expect(Object.keys(MESSAGES).toSorted()).toEqual([...LOCALES].toSorted());
  });
});

describe("isLocale", () => {
  it("accepts exactly the values in LOCALES", (): void => {
    expect(isLocale("en-us")).toBe(true);
    expect(isLocale("pt-br")).toBe(true);
  });

  it("rejects other strings, casing variants and non-strings", (): void => {
    expect(isLocale("EN-US")).toBe(false);
    expect(isLocale("pt")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(1)).toBe(false);
    expect(isLocale(["en-us"])).toBe(false);
  });
});

describe("messagesFor", () => {
  it("returns the catalog registered for the locale", (): void => {
    expect(messagesFor("en-us")).toBe(MESSAGES["en-us"]);
    expect(messagesFor("pt-br")).toBe(MESSAGES["pt-br"]);
  });

  it("returns distinct catalogs for each locale", (): void => {
    expect(messagesFor("en-us")).not.toBe(messagesFor("pt-br"));
  });
});

describe("describeError", () => {
  it("stringifies errors and any other value", (): void => {
    expect(describeError(new Error("boom"))).toBe("Error: boom");
    expect(describeError("plain")).toBe("plain");
    expect(describeError(42)).toBe("42");
    expect(describeError(null)).toBe("null");
  });
});

describe("whisperLanguage", () => {
  it("maps en-us to en and pt-br to pt", (): void => {
    expect(MESSAGES["en-us"].whisperLanguage).toBe("en");
    expect(MESSAGES["pt-br"].whisperLanguage).toBe("pt");
  });
});

describe("writeOtherAnswer", () => {
  it("names the question header in brackets when the question has one", (): void => {
    expect(MESSAGES["en-us"].writeOtherAnswer(2, "Scope", null)).toBe(
      "✍️ Type here the answer to question 2 [Scope].",
    );
    expect(MESSAGES["pt-br"].writeOtherAnswer(2, "Escopo", null)).toBe(
      "✍️ Escreva aqui a resposta da pergunta 2 [Escopo].",
    );
  });

  it("leaves the brackets out when the question has no header", (): void => {
    expect(MESSAGES["en-us"].writeOtherAnswer(1, null, null)).toBe(
      "✍️ Type here the answer to question 1.",
    );
    expect(MESSAGES["pt-br"].writeOtherAnswer(1, null, null)).toBe(
      "✍️ Escreva aqui a resposta da pergunta 1.",
    );
  });

  it("adds a line with the typed text it replaces, with and without header", (): void => {
    expect(MESSAGES["en-us"].writeOtherAnswer(2, "Scope", "Mobile")).toBe(
      "✍️ Type here the answer to question 2 [Scope].\n🔁 Replaces the answer typed before: “Mobile”.",
    );
    expect(MESSAGES["pt-br"].writeOtherAnswer(2, "Escopo", "Mobile")).toBe(
      "✍️ Escreva aqui a resposta da pergunta 2 [Escopo].\n🔁 Substitui a resposta escrita antes: “Mobile”.",
    );
    expect(MESSAGES["en-us"].writeOtherAnswer(1, null, "Infra")).toBe(
      "✍️ Type here the answer to question 1.\n🔁 Replaces the answer typed before: “Infra”.",
    );
    expect(MESSAGES["pt-br"].writeOtherAnswer(1, null, "Infra")).toBe(
      "✍️ Escreva aqui a resposta da pergunta 1.\n🔁 Substitui a resposta escrita antes: “Infra”.",
    );
  });
});

describe("typed answer notices", () => {
  it("tells that a text went to Claude and how to answer the question with text", (): void => {
    expect(MESSAGES["en-us"].otherNeedsPrompt(2, "Animal")).toBe(
      "ℹ️ That went to Claude as a message. To answer question 2 [Animal] with text, tap “✍️ Other answer” again and reply quoting the request.",
    );
    expect(MESSAGES["pt-br"].otherNeedsPrompt(2, "Animal")).toBe(
      "ℹ️ Isso foi como mensagem para o Claude. Para responder a pergunta 2 [Animal] com texto, toque de novo em “✍️ Outra resposta” e responda citando o pedido.",
    );
    expect(MESSAGES["pt-br"].otherNeedsPrompt(1, null)).toBe(
      "ℹ️ Isso foi como mensagem para o Claude. Para responder a pergunta 1 com texto, toque de novo em “✍️ Outra resposta” e responda citando o pedido.",
    );
    expect(MESSAGES["en-us"].otherNeedsPrompt(1, null)).toBe(
      "ℹ️ That went to Claude as a message. To answer question 1 with text, tap “✍️ Other answer” again and reply quoting the request.",
    );
  });

  it("warns that a text quoting an answered question was not used, with the answer it kept", (): void => {
    expect(MESSAGES["en-us"].otherAlreadyAnswered(1, "Season", "Winter")).toBe(
      "⚠️ Question 1 [Season] was already answered with Winter; this text was not used.",
    );
    expect(
      MESSAGES["pt-br"].otherAlreadyAnswered(1, "Estação", "Inverno"),
    ).toBe(
      "⚠️ A pergunta 1 [Estação] já foi respondida com Inverno; este texto não foi usado.",
    );
    expect(MESSAGES["en-us"].otherAlreadyAnswered(3, null, "Yes")).toBe(
      "⚠️ Question 3 was already answered with Yes; this text was not used.",
    );
    expect(MESSAGES["pt-br"].otherAlreadyAnswered(3, null, "Sim")).toBe(
      "⚠️ A pergunta 3 já foi respondida com Sim; este texto não foi usado.",
    );
  });
});

describe("catalog parity between en-us and pt-br", () => {
  it("has the same keys", (): void => {
    expect(Object.keys(MESSAGES["pt-br"]).toSorted()).toEqual(
      Object.keys(MESSAGES["en-us"]).toSorted(),
    );
  });

  it("has the same kind of value for every key, string or function", (): void => {
    const kinds = (locale: Locale): [string, string][] =>
      entriesOf(locale)
        .toSorted(byKey)
        .map(([key, value]): [string, string] => [key, typeof value]);

    expect(kinds("pt-br")).toEqual(kinds("en-us"));
    expect(
      kinds("en-us").every(
        ([, kind]) => kind === "string" || kind === "function",
      ),
    ).toBe(true);
  });

  it("has the same arity for every function", (): void => {
    const arities = (locale: Locale): [string, number][] =>
      entriesOf(locale)
        .toSorted(byKey)
        .flatMap(([key, value]): [string, number][] =>
          typeof value === "function" ? [[key, value.length]] : [],
        );

    expect(arities("pt-br")).toEqual(arities("en-us"));
    expect(arities("en-us").length).toBeGreaterThan(0);
  });

  it("has no empty text", (): void => {
    const empty = LOCALES.flatMap((locale) =>
      entriesOf(locale)
        .filter(([, value]) => typeof value === "string" && value.trim() === "")
        .map(([key]) => `${locale}.${key}`),
    );

    expect(empty).toEqual([]);
  });

  it("covers every function of the catalog with sample arguments", (): void => {
    expect(Object.keys(FUNCTION_CALLS).toSorted()).toEqual(
      functionKeys("en-us"),
    );
    expect(functionKeys("pt-br")).toEqual(functionKeys("en-us"));
  });

  it("returns a non-empty string from every function, echoing its string arguments", (): void => {
    const problems = LOCALES.flatMap((locale) =>
      functionKeys(locale).filter((key) => {
        const result = callMessage(locale, key);
        const echoed = FUNCTION_CALLS[key]
          .filter((argument) => typeof argument === "string")
          .every((argument) => result.includes(argument));

        return result.trim() === "" || !echoed;
      }),
    );

    expect(problems).toEqual([]);
  });
});
