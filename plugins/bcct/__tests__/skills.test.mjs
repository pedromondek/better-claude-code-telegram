import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SETTABLE_STEPS } from "../../../scripts/setup.mjs";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const SKILLS_DIR = join(PLUGIN_ROOT, "skills");
const TERMINAL_ONLY = new Set(["pairing", "setup", "token", "uninstall"]);

function skills() {
  return readdirSync(SKILLS_DIR).map((name) => {
    const text = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";

    return { name, text, frontmatter };
  });
}

describe("bcct skills", () => {
  it("has the commands of the setup that do not need a secret, plus the ones that point to the terminal", () => {
    expect(
      skills()
        .map(({ name }) => name)
        .toSorted(),
    ).toEqual(
      [
        "delay",
        "health",
        "inbox",
        "language",
        "pairing",
        "quiet-hours",
        "release",
        "setup",
        "statusline",
        "token",
        "transcription",
        "uninstall",
      ].toSorted(),
    );
  });

  it("names each skill after its folder and only runs when the user types it", () => {
    for (const { name, frontmatter } of skills()) {
      expect(frontmatter).toContain(`name: ${name}\n`);
      expect(frontmatter).toContain("disable-model-invocation: true");
      expect(frontmatter).toMatch(/\ndescription: \S/);
    }
  });

  it("points only to scripts that exist in the repository", () => {
    for (const { text } of skills()) {
      for (const [, script] of text.matchAll(
        /\$\{CLAUDE_PLUGIN_ROOT\}\/(\.\.\/\.\.\/scripts\/[\w-]+\.mjs)/g,
      )) {
        expect(existsSync(resolve(PLUGIN_ROOT, script))).toBe(true);
      }
    }
  });

  it("sets only the steps the setup accepts with --set", () => {
    for (const { text } of skills()) {
      for (const [, step] of text.matchAll(/--set ([\w-]+)/g)) {
        expect(SETTABLE_STEPS).toContain(step);
      }
    }
  });

  it("gives the commands that need the terminal no tool to run anything", () => {
    const terminalSkills = skills().filter(({ name }) =>
      TERMINAL_ONLY.has(name),
    );

    expect(terminalSkills).toHaveLength(TERMINAL_ONLY.size);

    for (const { frontmatter } of terminalSkills) {
      expect(frontmatter).not.toContain("allowed-tools");
    }
  });
});
