import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SETTABLE_STEPS } from "../../../scripts/setup.mjs";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const SKILLS_DIR = join(PLUGIN_ROOT, "skills");
const TERMINAL_ONLY = new Set(["pairing", "setup", "token", "uninstall"]);
const RUST_SOURCE = join(
  PLUGIN_ROOT,
  "..",
  "..",
  "rust",
  "crates",
  "bcct",
  "src",
);
const SHIM_PATH = "${CLAUDE_PLUGIN_ROOT}/scripts/bcct";
const SHIM_RUN = /"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/bcct" (\w+)/g;
const SETUP_COMMAND = "npx @pedromondek/better-claude-code-telegram";
const SKILL_SUBCOMMANDS = {
  delay: "setup",
  health: "health",
  inbox: "setup",
  language: "setup",
  "quiet-hours": "setup",
  release: "release",
  statusline: "setup",
  transcription: "setup",
  update: "update",
};

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
        "update",
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

  it("points only to files inside the plugin, which is all the plugin cache keeps", () => {
    for (const { text } of skills()) {
      expect(text).not.toContain("../");

      for (const [, file] of text.matchAll(
        /\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g,
      )) {
        expect(existsSync(resolve(PLUGIN_ROOT, file))).toBe(true);
      }
    }
  });

  it("runs every command through the script of the plugin, never node, sh or npm run", () => {
    for (const { text } of skills()) {
      expect(text).not.toMatch(/\bnode "/);
      expect(text).not.toMatch(/\bsh "/);
      expect(text).not.toContain("npm run");
      expect(text).not.toContain("repository folder");
    }
  });

  it("sends the steps that need the terminal to npx @pedromondek/better-claude-code-telegram", () => {
    const steps = {
      pairing: `${SETUP_COMMAND} pairing`,
      setup: SETUP_COMMAND,
      token: `${SETUP_COMMAND} token`,
      uninstall: `${SETUP_COMMAND} uninstall`,
    };

    const texts = Object.fromEntries(
      skills().map(({ name, text }) => [name, text]),
    );

    expect(
      Object.fromEntries(
        Object.entries(steps).map(([name, command]) => [
          name,
          (texts[name] ?? "").includes(`\`${command}\``),
        ]),
      ),
    ).toEqual({ pairing: true, setup: true, token: true, uninstall: true });
  });

  it("allows exactly the subcommand each skill runs, and nothing else", () => {
    const usage = Object.fromEntries(
      skills().map(({ name, frontmatter, text }) => [
        name,
        {
          tools: [...frontmatter.matchAll(/^ {2}- (Bash\(.*\))$/gm)].map(
            ([, tool]) => tool,
          ),
          runs: [
            ...new Set(
              [...text.matchAll(SHIM_RUN)]
                .filter(({ index }) => text[index - 1] !== "(")
                .map(([, subcommand]) => subcommand),
            ),
          ],
        },
      ]),
    );
    const expected = Object.fromEntries(
      skills().map(({ name }) => [
        name,
        SKILL_SUBCOMMANDS[name]
          ? {
              tools: [`Bash("${SHIM_PATH}" ${SKILL_SUBCOMMANDS[name]} *)`],
              runs: [SKILL_SUBCOMMANDS[name]],
            }
          : { tools: [], runs: [] },
      ]),
    );

    expect(usage).toEqual(expected);
  });

  it("only uses flags of the setup, the health and the update that the bcct of this repository has", () => {
    const source = ["setup_run.rs", "health.rs", "update.rs"]
      .map((file) => readFileSync(join(RUST_SOURCE, file), "utf8"))
      .join("");
    const flags = [
      ...new Set(
        skills().flatMap(({ text }) =>
          [...text.matchAll(/`"\$\{CLAUDE_PLUGIN_ROOT\}[^`]*`/g)].flatMap(
            ([command]) =>
              [...command.matchAll(/ (--[a-z-]+)/g)].map(([, flag]) => flag),
          ),
        ),
      ),
    ];

    expect(flags.toSorted()).toEqual([
      "--check",
      "--fix",
      "--json",
      "--only",
      "--set",
      "--show",
      "--statusline-prompt",
      "--take",
    ]);

    for (const flag of flags) {
      expect(source).toContain(`"${flag}"`);
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
