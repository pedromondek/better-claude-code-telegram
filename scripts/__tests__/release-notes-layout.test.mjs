import { describe, expect, it } from "vitest";

import {
  BLOCK_END,
  ENGLISH_BLOCK,
  PORTUGUESE_BLOCK,
  emptyNotes,
  followAlert,
  legendAlert,
  notesSkeleton,
} from "../release-notes-layout.mjs";

const FOLLOW = [
  "> [!TIP]",
  "> 📣 **Follow the releases on Telegram · Acompanhe os lançamentos no Telegram**\\",
  "> 🇺🇸 [@bcct_tips](https://t.me/bcct_tips) (stable) · [@bcct_tips_prereleases](https://t.me/bcct_tips_prereleases) (every version)\\",
  "> 🇧🇷 [@bcct_tips_br](https://t.me/bcct_tips_br) (estáveis) · [@bcct_tips_prelancamentos](https://t.me/bcct_tips_prelancamentos) (todas as versões)",
].join("\n");
const LEGEND =
  "> [!NOTE]\n> ✨ new · novo&emsp;&emsp;🐛 fix · correção&emsp;&emsp;⚡ performance · desempenho&emsp;&emsp;🔐 security · segurança";

describe("the language blocks", () => {
  it("are collapsed blocks named by the flag and the language", () => {
    expect(ENGLISH_BLOCK).toBe("<details><summary>🇺🇸 English</summary>");
    expect(PORTUGUESE_BLOCK).toBe("<details><summary>🇧🇷 Português</summary>");
    expect(BLOCK_END).toBe("</details>");
  });
});

describe("followAlert", () => {
  it("builds the TIP with both titles and the stable and pre-release channels of each language", () => {
    expect(followAlert()).toBe(FOLLOW);
  });

  it("breaks the lines with a backslash, so the alert keeps no trailing spaces", () => {
    expect(
      followAlert()
        .split("\n")
        .some((line) => line.endsWith(" ")),
    ).toBe(false);
  });
});

describe("legendAlert", () => {
  it("builds the NOTE with the new, fix, performance and security emojis in both languages", () => {
    expect(legendAlert()).toBe(LEGEND);
  });
});

describe("notesSkeleton", () => {
  it("puts the draft mark, the two alerts, the draft in the English block and an empty Portuguese block", () => {
    expect(notesSkeleton("### Features\n- x")).toBe(
      [
        "<!-- draft -->",
        FOLLOW,
        "",
        LEGEND,
        "",
        ENGLISH_BLOCK,
        "",
        "### Features\n- x",
        "",
        BLOCK_END,
        "",
        PORTUGUESE_BLOCK,
        "",
        BLOCK_END,
      ].join("\n"),
    );
  });

  it("gives the empty notes as the skeleton of an empty draft without the draft mark", () => {
    expect(emptyNotes()).toBe(
      notesSkeleton("").replace("<!-- draft -->\n", ""),
    );
    expect(emptyNotes().includes("<!-- draft -->")).toBe(false);
  });

  it("leaves the English block empty when git-cliff found nothing", () => {
    expect(notesSkeleton("")).toContain(`${ENGLISH_BLOCK}\n\n${BLOCK_END}`);
  });
});
