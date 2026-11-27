import { describe, expect, it } from "vitest";

import {
  BLOCK_END,
  ENGLISH_BLOCK,
  PORTUGUESE_BLOCK,
  followAlert,
  installAlert,
  legendAlert,
  notesSkeleton,
  updateAlert,
} from "../release-notes-layout.mjs";

const VERSION = "0.2.0-alpha.3";
const installFor = (command, version = VERSION) =>
  [
    "> [!IMPORTANT]",
    "> 🚀 **Install · Instalar**",
    "> ```",
    `> ${command}`,
    "> ```",
    "> 📌 **This exact version · Esta versão exata**",
    "> ```",
    `> npx @pedromondek/better-claude-code-telegram@${version}`,
    "> ```",
    "> Then · Depois: `claude --telegram`",
  ].join("\n");
const updateFor = (command) =>
  [
    "> [!IMPORTANT]",
    "> 🔄 **Update · Atualizar**",
    "> ```",
    "> bcct update",
    "> ```",
    "> Or, without bcct on the PATH · Ou, sem o bcct no PATH:",
    "> ```",
    `> ${command} update`,
    "> ```",
    "> Or in Claude Code · Ou no Claude Code:",
    "> ```",
    "> /bcct:update",
    "> ```",
  ].join("\n");
const ALPHA = "npx @pedromondek/better-claude-code-telegram@alpha";
const INSTALL = installFor(ALPHA);
const UPDATE = updateFor(ALPHA);

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

describe("installAlert", () => {
  it("builds the IMPORTANT with the install command on the dist-tag of a pre-release and the exact version", () => {
    expect(installAlert(VERSION)).toBe(INSTALL);
  });

  it.each([
    ["0.2.0-beta.1", "npx @pedromondek/better-claude-code-telegram@beta"],
    ["0.2.0-rc.2", "npx @pedromondek/better-claude-code-telegram@next"],
    ["0.2.0", "npx @pedromondek/better-claude-code-telegram"],
  ])("installs %s with %s", (version, command) => {
    expect(installAlert(version)).toBe(installFor(command, version));
  });
});

describe("updateAlert", () => {
  it("builds a second IMPORTANT with bcct update, the npx update of the dist-tag and /bcct:update", () => {
    expect(updateAlert(VERSION)).toBe(UPDATE);
  });

  it("updates a stable version through npx with no tag", () => {
    expect(updateAlert("0.2.0")).toBe(
      updateFor("npx @pedromondek/better-claude-code-telegram"),
    );
  });

  it("keeps no trailing spaces in either alert", () => {
    expect(
      [installAlert(VERSION), updateAlert(VERSION)]
        .join("\n")
        .split("\n")
        .some((line) => line.endsWith(" ")),
    ).toBe(false);
  });
});

describe("notesSkeleton", () => {
  it("puts the draft mark, the four alerts, the draft in the English block and an empty Portuguese block", () => {
    expect(notesSkeleton("### Features\n- x", VERSION)).toBe(
      [
        "<!-- draft -->",
        FOLLOW,
        "",
        INSTALL,
        "",
        UPDATE,
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

  it("leaves the English block empty when git-cliff found nothing", () => {
    expect(notesSkeleton("", VERSION)).toContain(
      `${ENGLISH_BLOCK}\n\n${BLOCK_END}`,
    );
  });
});
