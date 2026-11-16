import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BUILD_SWAP,
  DEFAULT_BUILD_JOBS,
  DEFAULT_BUILD_MEMORY,
  LAUNCHER_ONLY_PLUGIN,
  builtBinary,
  devBinary,
  devPlugins,
  runDev,
} from "../dev-install.mjs";

const MARKETPLACE = {
  name: "better-claude-code-telegram",
  plugins: [
    { name: "telegram", source: "./plugins/telegram" },
    { name: "telegram-hooks", source: "./plugins/telegram-hooks" },
    { name: "bcct", source: "./plugins/bcct" },
  ],
};
const BINARY = Buffer.from("fake bcct binary");
const BINARY_SHA = createHash("sha256").update(BINARY).digest("hex");
const ENV = { PATH: "/usr/bin", HOME: "/home/usuario.teste" };

function fakeRun(answers = {}) {
  const calls = [];

  return {
    calls,
    run: (command, args, options = {}) => {
      calls.push({ command, args, env: options.env });
      const key = [command, ...args].join(" ");
      const found = Object.entries(answers).find(([prefix]) =>
        key.startsWith(prefix),
      );

      return found?.[1] ?? { status: 0, stdout: "", stderr: "" };
    },
  };
}

function binary({ env = ENV, platform = "linux", answers } = {}) {
  const fake = fakeRun(answers);
  const lines = [];
  const read = [];
  const code = devBinary({
    env,
    platform,
    cwd: "/repo",
    run: fake.run,
    readFile: (path) => {
      read.push(path);
      return BINARY;
    },
    log: (line) => lines.push(line),
  });

  return { code, calls: fake.calls, read, output: lines.join("\n") };
}

function plugins(answers) {
  const fake = fakeRun(answers);
  const lines = [];
  const code = devPlugins({
    marketplace: MARKETPLACE,
    run: fake.run,
    log: (line) => lines.push(line),
  });

  return { code, calls: fake.calls, output: lines.join("\n") };
}

const FAILED = { status: 1, stdout: "", stderr: "boom" };
const MISSING = { error: { code: "ENOENT" } };

describe("dev-install › binary", () => {
  it("builds under the memory cap when systemd-run exists", () => {
    const { code, calls } = binary({
      env: { ...ENV, CARGO_TARGET_DIR: "/mnt/d/target" },
    });

    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({
      command: "systemd-run",
      args: ["--version"],
    });
    expect(calls[1].command).toBe("systemd-run");
    expect(calls[1].args).toEqual([
      "--user",
      "--wait",
      "--collect",
      "-P",
      "-p",
      `MemoryMax=${DEFAULT_BUILD_MEMORY}`,
      "-p",
      `MemorySwapMax=${BUILD_SWAP}`,
      "--working-directory=/repo",
      "-E",
      "PATH=/usr/bin",
      "-E",
      "HOME=/home/usuario.teste",
      "-E",
      "CARGO_TARGET_DIR=/mnt/d/target",
      "-E",
      `CARGO_BUILD_JOBS=${DEFAULT_BUILD_JOBS}`,
      "npm",
      "run",
      "--silent",
      "rust:build",
    ]);
  });

  it("takes the memory and the jobs of the build from the environment", () => {
    const { calls } = binary({
      env: { ...ENV, BCCT_BUILD_MEMORY: "3G", CARGO_BUILD_JOBS: "2" },
    });

    expect(calls[1].args).toContain("MemoryMax=3G");
    expect(calls[1].args).toContain("CARGO_BUILD_JOBS=2");
    expect(calls[1].args.join(" ")).not.toContain("CARGO_TARGET_DIR");
  });

  it("builds without the cap when systemd-run is missing or fails", () => {
    for (const probe of [MISSING, FAILED]) {
      const { code, calls } = binary({
        answers: { "systemd-run --version": probe },
      });

      expect(code).toBe(0);
      expect(calls[1]).toEqual({
        command: "npm",
        args: ["run", "--silent", "rust:build"],
        env: { ...ENV, CARGO_BUILD_JOBS: DEFAULT_BUILD_JOBS },
      });
    }
  });

  it("builds without probing systemd outside Linux", () => {
    const { calls } = binary({ platform: "darwin" });

    expect(calls[0].command).toBe("npm");
  });

  it("installs the built binary with its sha256 and shows its version", () => {
    const { code, calls, read, output } = binary({
      answers: {
        "rust/target/release/bcct --version": {
          status: 0,
          stdout: "bcct 0.1.0\nInstaladas:\n  estável  0.1.0 (ativa)\n",
          stderr: "",
        },
      },
    });

    expect(code).toBe(0);
    expect(read).toEqual(["rust/target/release/bcct"]);
    expect(calls.slice(2)).toEqual([
      {
        command: "rust/target/release/bcct",
        args: [
          "self-install",
          "rust/target/release/bcct",
          "--sha256",
          BINARY_SHA,
          "--from",
          "manual",
        ],
        env: undefined,
      },
      {
        command: "rust/target/release/bcct",
        args: ["--version"],
        env: undefined,
      },
    ]);
    expect(output).toContain("✔ bcct 0.1.0 installed");
    expect(output).not.toContain("Instaladas");
  });

  it("stops without installing when the build fails", () => {
    const { code, calls, output } = binary({
      answers: { "systemd-run --user": FAILED },
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
    expect(output).toContain("✗ build failed");
  });

  it("fails with the output of self-install when the install fails", () => {
    const { code, output } = binary({
      answers: { "rust/target/release/bcct self-install": FAILED },
    });

    expect(code).toBe(1);
    expect(output).toContain("✗ self-install failed");
    expect(output).toContain("boom");
  });
});

describe("dev-install › builtBinary", () => {
  it("names the binary in the target folder of the platform", () => {
    expect(builtBinary({}, "linux")).toBe("rust/target/release/bcct");
    expect(builtBinary({ CARGO_TARGET_DIR: "/mnt/d/t" }, "linux")).toBe(
      "/mnt/d/t/release/bcct",
    );
    expect(builtBinary({}, "win32")).toBe("rust/target/release/bcct.exe");
  });
});

describe("dev-install › plugins", () => {
  it("reinstalls each plugin and turns the launcher plugin off", () => {
    const { code, calls, output } = plugins();

    expect(code).toBe(0);
    expect(calls.map(({ args }) => args.join(" "))).toEqual([
      "plugin uninstall telegram@better-claude-code-telegram",
      "plugin install telegram@better-claude-code-telegram",
      "plugin uninstall telegram-hooks@better-claude-code-telegram",
      "plugin install telegram-hooks@better-claude-code-telegram",
      "plugin uninstall bcct@better-claude-code-telegram",
      "plugin install bcct@better-claude-code-telegram",
      "plugin disable telegram@better-claude-code-telegram",
    ]);
    expect(calls.every(({ command }) => command === "claude")).toBe(true);
    expect(output).toContain(
      "reopen claude --telegram, or run /reload-plugins and /mcp reconnect plugin:telegram:telegram",
    );
  });

  it("installs a plugin that was not installed before", () => {
    const { code, calls } = plugins({
      "claude plugin uninstall bcct@": FAILED,
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(7);
  });

  it("stops with the output when an install fails", () => {
    const { code, calls, output } = plugins({
      "claude plugin install telegram-hooks@": FAILED,
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(4);
    expect(output).toContain("✗ telegram-hooks@better-claude-code-telegram");
    expect(output).toContain("boom");
  });

  it("fails when the launcher plugin does not turn off", () => {
    const { code, output } = plugins({ "claude plugin disable": FAILED });

    expect(code).toBe(1);
    expect(output).toContain("boom");
  });

  it("fails when claude is not installed", () => {
    const { code, calls, output } = plugins({ claude: MISSING });

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(output).toContain("claude is not installed");
  });

  it("names a plugin of the marketplace as the launcher plugin", () => {
    const marketplace = JSON.parse(
      readFileSync(".claude-plugin/marketplace.json", "utf8"),
    );

    expect(marketplace.plugins.map(({ name }) => name)).toContain(
      LAUNCHER_ONLY_PLUGIN,
    );
  });
});

describe("dev-install › command", () => {
  function steps(codes = {}) {
    const ran = [];
    const lines = [];
    const step = (name) => () => {
      ran.push(name);
      return codes[name] ?? 0;
    };

    return {
      ran,
      lines,
      deps: {
        binary: step("binary"),
        plugins: step("plugins"),
        log: (line) => lines.push(line),
      },
    };
  }

  it("runs the step named in the arguments", () => {
    const { ran, deps } = steps();

    expect(runDev("binary", deps)).toBe(0);
    expect(runDev("plugins", deps)).toBe(0);
    expect(ran).toEqual(["binary", "plugins"]);
  });

  it("runs the binary and then the plugins for install", () => {
    const { ran, deps } = steps();

    expect(runDev("install", deps)).toBe(0);
    expect(ran).toEqual(["binary", "plugins"]);
  });

  it("skips the plugins of install when the binary fails", () => {
    const { ran, deps } = steps({ binary: 1 });

    expect(runDev("install", deps)).toBe(1);
    expect(ran).toEqual(["binary"]);
  });

  it("returns the failure of the plugins in install", () => {
    const { deps } = steps({ plugins: 1 });

    expect(runDev("install", deps)).toBe(1);
  });

  it("refuses another step with the usage", () => {
    const { ran, lines, deps } = steps();

    expect(runDev("other", deps)).toBe(1);
    expect(runDev(undefined, deps)).toBe(1);
    expect(ran).toEqual([]);
    expect(lines.join("\n")).toContain(
      "dev-install.mjs <binary|plugins|install>",
    );
  });
});
