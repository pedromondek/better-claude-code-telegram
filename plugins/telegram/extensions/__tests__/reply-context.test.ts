import { describe, expect, it } from "vitest";

import { MESSAGES } from "../i18n.ts";
import { withReplyContext } from "../reply-context.ts";

const PT = MESSAGES["pt-br"];
const EN = MESSAGES["en-us"];

describe("withReplyContext in pt-br", () => {
  it("returns the text as is when it is not a reply", (): void => {
    expect(withReplyContext("ok", undefined, PT)).toBe("ok");
    expect(withReplyContext("ok", { text: "   " }, PT)).toBe("ok");
  });

  it("puts the full replied Claude message first", (): void => {
    const longText = "linha\n".repeat(500).trim();

    expect(
      withReplyContext(
        "pode seguir",
        { text: longText, from: { is_bot: true } },
        PT,
      ),
    ).toBe(
      `↩️ Em resposta à mensagem do Claude:\n«${longText}»\n\npode seguir`,
    );
  });

  it("uses the photo caption and recognizes the dev's own message", (): void => {
    expect(
      withReplyContext(
        "essa aqui",
        { caption: "print do erro", from: { is_bot: false } },
        PT,
      ),
    ).toBe("↩️ Em resposta à própria mensagem:\n«print do erro»\n\nessa aqui");
  });
});

describe("withReplyContext in en-us", () => {
  it("returns the text as is when it is not a reply", (): void => {
    expect(withReplyContext("ok", undefined, EN)).toBe("ok");
    expect(withReplyContext("ok", { caption: "  " }, EN)).toBe("ok");
  });

  it("labels a replied Claude message", (): void => {
    expect(
      withReplyContext(
        "go ahead",
        { text: "done?", from: { is_bot: true } },
        EN,
      ),
    ).toBe("↩️ In reply to Claude's message:\n«done?»\n\ngo ahead");
  });

  it("labels the dev's own message, with or without from", (): void => {
    expect(
      withReplyContext(
        "this one",
        { caption: "error screenshot", from: { is_bot: false } },
        EN,
      ),
    ).toBe("↩️ In reply to their own message:\n«error screenshot»\n\nthis one");
    expect(withReplyContext("this one", { text: "hi" }, EN)).toBe(
      "↩️ In reply to their own message:\n«hi»\n\nthis one",
    );
  });

  it("trims the replied text", (): void => {
    expect(withReplyContext("x", { text: "  hi  " }, EN)).toBe(
      "↩️ In reply to their own message:\n«hi»\n\nx",
    );
  });
});
