import { describe, expect, it } from "vitest";

import {
  pluginTargets,
  validatePlugins,
  withIsolatedConfig,
} from "../validate-plugins.mjs";

const MARKETPLACE = {
  plugins: [
    { name: "telegram", source: "./plugins/telegram" },
    { name: "telegram-hooks", source: "./plugins/telegram-hooks" },
    { name: "bcct", source: "./plugins/bcct" },
  ],
};

function fakeClaude(failing = {}, missing = false) {
  const calls = [];

  return {
    calls,
    run: (args) => {
      calls.push(args);
      if (missing) return { error: { code: "ENOENT" } };
      const path = args.at(-1);

      return path in failing
        ? { status: 1, stdout: failing[path], stderr: "" }
        : { status: 0, stdout: "✔ Validation passed", stderr: "" };
    },
  };
}

function validated({ failing, missing, env = {} } = {}) {
  const claude = fakeClaude(failing, missing);
  const lines = [];
  const code = validatePlugins({
    marketplace: MARKETPLACE,
    run: claude.run,
    env,
    log: (line) => lines.push(line),
  });

  return { code, calls: claude.calls, output: lines.join("\n") };
}

describe("pluginTargets", () => {
  it("validates every plugin of the marketplace, strict except the upstream one, and the marketplace itself", () => {
    expect(pluginTargets(MARKETPLACE)).toEqual([
      { path: "plugins/telegram", strict: false },
      { path: "plugins/telegram-hooks", strict: true },
      { path: "plugins/bcct", strict: true },
      { path: ".", strict: false },
    ]);
  });
});

describe("withIsolatedConfig", () => {
  function isolated(action) {
    const spawned = [];
    const removed = [];
    let result;
    let thrown;

    try {
      result = withIsolatedConfig(action, {
        env: { PATH: "/bin", CLAUDE_CONFIG_DIR: "/home/dev/.claude" },
        makeDir: () => "/tmp/bcct-claude-1",
        removeDir: (dir) => removed.push(dir),
        spawn: (command, args, options) => {
          spawned.push({ command, args, options });

          return { status: 0 };
        },
      });
    } catch (error) {
      thrown = error;
    }

    return { result, thrown, spawned, removed };
  }

  it("runs claude with a temporary config folder instead of the one in use, keeping the rest of the environment", () => {
    const { result, spawned, removed } = isolated((run) => {
      run(["plugin", "validate", "."]);

      return 7;
    });

    expect(result).toBe(7);
    expect(spawned).toEqual([
      {
        command: "claude",
        args: ["plugin", "validate", "."],
        options: {
          encoding: "utf8",
          env: { PATH: "/bin", CLAUDE_CONFIG_DIR: "/tmp/bcct-claude-1" },
        },
      },
    ]);
    expect(removed).toEqual(["/tmp/bcct-claude-1"]);
  });

  it("removes the temporary folder even when the validation throws", () => {
    const { thrown, removed } = isolated(() => {
      throw new Error("boom");
    });

    expect(thrown?.message).toBe("boom");
    expect(removed).toEqual(["/tmp/bcct-claude-1"]);
  });
});

describe("validatePlugins", () => {
  it("runs claude plugin validate on each target and exits 0 when all pass", () => {
    const { code, calls } = validated();

    expect(code).toBe(0);
    expect(calls).toEqual([
      ["plugin", "validate", "plugins/telegram"],
      ["plugin", "validate", "--strict", "plugins/telegram-hooks"],
      ["plugin", "validate", "--strict", "plugins/bcct"],
      ["plugin", "validate", "."],
    ]);
  });

  it("exits 1 and shows the report of each target that failed", () => {
    const { code, output } = validated({
      failing: { "plugins/bcct": "✘ name: missing" },
    });

    expect(code).toBe(1);
    expect(output).toContain("✗ plugins/bcct");
    expect(output).toContain("✘ name: missing");
    expect(output).not.toContain("✗ plugins/telegram-hooks");
  });

  it("skips with a warning on a machine without the claude CLI", () => {
    const { code, calls, output } = validated({ missing: true });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(output).toContain("⚠ claude is not installed");
  });

  it("fails in CI without the claude CLI, which the workflow installs", () => {
    const { code, output } = validated({ missing: true, env: { CI: "true" } });

    expect(code).toBe(1);
    expect(output).toContain("✗ claude is not installed");
  });
});
