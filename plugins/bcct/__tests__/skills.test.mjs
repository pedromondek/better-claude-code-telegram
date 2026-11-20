import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
  visuals: "setup",
};
const HEALTH_CHECK_LABELS = {
  Claude: "claude",
  Bun: "bun",
  Git: "git",
  Plugins: "plugins",
  Launcher: "launcher",
  Version: "binary and plugin versions",
  Shell: "shell line",
  Path: "bcct on PATH",
  AppDir: "app folder",
  Hooks: "hook warnings",
  Token: "bot token",
  Groups: "bot kept out of groups",
  Pairing: "pairing",
  Polling: "connection",
  User: "not running as root",
  Protection: "the deny rule",
  Config: "settings",
  Transcription: "transcription",
  Mermaid: "diagrams",
  Chromium: "Chromium",
  Ffmpeg: "ffmpeg",
  Statusline: "status line",
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
        "visuals",
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

  it("sets only the steps the bcct setup accepts with --set", () => {
    const source = readFileSync(join(RUST_SOURCE, "setup_run.rs"), "utf8");
    const settable = /const SETTABLE_STEPS: \[&str; \d+\] = \[([^\]]+)\]/u
      .exec(source)?.[1]
      .match(/"[\w-]+"/gu)
      ?.map((step) => step.slice(1, -1));

    expect(settable).toContain("delays");

    for (const { text } of skills()) {
      for (const [, step] of text.matchAll(/--set ([\w-]+)/g)) {
        expect(settable).toContain(step);
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

  it("asks whether to group or choose first, and shows the four groups only when choosing", () => {
    const health = skills().find(({ name }) => name === "health");

    expect(health?.text).toContain(
      'call AskUserQuestion once, header "Health", with two options: "All (Recommended)", which checks every group, and "Choose groups".',
    );
    expect(health?.text).toContain(
      'Only after "Choose groups", call AskUserQuestion again, `multiSelect: true`, header "Groups"',
    );
  });

  it("describes each health group by the checks the bcct runs in it, without a Node check", () => {
    const health = skills().find(({ name }) => name === "health");
    const source = readFileSync(join(RUST_SOURCE, "health.rs"), "utf8");
    const body = /fn checks\(self\)[\s\S]*?\n {4}\}\n/u.exec(source)?.[0] ?? "";
    const groups = [...body.matchAll(/Self::(\w+) => &\[([^\]]*)\]/gu)].map(
      ([, group, checks]) => [
        group.toLowerCase(),
        [...checks.matchAll(/Check::(\w+)/gu)].map(([, check]) => check),
      ],
    );

    expect(groups.map(([group]) => group)).toEqual([
      "install",
      "telegram",
      "security",
      "extras",
    ]);
    for (const [group, checks] of groups) {
      const option =
        new RegExp(`\`${group}\` \\(([^)]*)\\)`, "u").exec(
          health?.text ?? "",
        )?.[1] ?? "";

      expect(option).not.toMatch(/\bNode\b/u);
      for (const check of checks) {
        expect(option).toContain(HEALTH_CHECK_LABELS[check]);
      }
    }
  });

  it("points the setup to every skill that changes a setting", () => {
    const setup = skills().find(({ name }) => name === "setup");
    const line =
      /^- Everything else can be changed from here: .*$/mu.exec(
        setup?.text ?? "",
      )?.[0] ?? "";
    const settings = Object.entries(SKILL_SUBCOMMANDS)
      .filter(([, subcommand]) => subcommand === "setup")
      .map(([name]) => `\`/bcct:${name}\``);

    expect(settings).toContain("`/bcct:inbox`");
    for (const command of settings) {
      expect(line).toContain(command);
    }
  });

  it("offers a delay per kind and saves it through --set delays, with 0 for right away", () => {
    const delay = skills().find(({ name }) => name === "delay");

    expect(delay?.frontmatter).toContain(
      'argument-hint: "[minutes | per kind]"',
    );
    expect(delay?.text).toContain(
      'one of them "Per kind…", with the kinds in its description',
    );
    expect(delay?.text).toContain(
      '`"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --set delays <questions>/<permissions>/<waiting>`',
    );
    expect(delay?.text).toContain("0 means right away");
  });

  it("asks the illustrations and the review, saying they cost tokens, and saves both through --set", () => {
    const visuals = skills().find(({ name }) => name === "visuals");

    expect(visuals?.frontmatter).toContain(
      'argument-hint: "[off | prints | video] [review | direct]"',
    );
    expect(visuals?.text).toContain("saying that they cost more tokens");
    expect(visuals?.text).toContain(
      '`"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --set visuals <off|prints|video>`',
    );
    expect(visuals?.text).toContain(
      '`"${CLAUDE_PLUGIN_ROOT}/scripts/bcct" setup --set visual-review <on|off>`',
    );
    expect(visuals?.text).toContain(
      "(`/mcp reconnect plugin:telegram:telegram` in that session)",
    );
  });

  it("tells the update accepts only the newest stable when the plugins change", () => {
    const update = skills().find(({ name }) => name === "update");

    expect(update?.text).toContain(
      "When the plugins need to change, the only stable version accepted is the newest stable: bcct refuses an older one with a line with ✘ that points to `bcct update stable`. Test versions (alpha, beta and rc) have no such limit.",
    );
  });

  it("switches the language of the Telegram replies in the session without a reconnect", () => {
    const language = skills().find(({ name }) => name === "language");

    expect(language?.text).toContain(
      "From now on, in this session, write every Telegram reply to the user in the chosen language.",
    );
    expect(language?.text).toContain(
      "The channel instructions keep naming the previous language until the channel reconnects; this choice overrides them.",
    );
  });
});
