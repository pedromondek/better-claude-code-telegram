import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  COMMAND,
  PACKAGE,
  PLATFORMS,
  SETUP_COMMAND,
} from "../shim/shim.constants.mjs";
import {
  binaryCommand,
  exitAsChild,
  expectedHash,
  localeOf,
  platformOf,
  releaseUrl,
  run,
  runBinary,
} from "../shim/shim.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SHIM = join(ROOT, "npm/shim/shim.mjs");
const VERSION = "0.2.0";
const BINARY = Buffer.from("bcct binary");
const HASH = createHash("sha256").update(BINARY).digest("hex");
const CHECKSUMS = [
  "# version asset sha256",
  `0.1.0 bcct-linux-x64 ${"0".repeat(64)}`,
  `${VERSION} bcct-linux-x64 ${HASH}`,
  `${VERSION} bcct-win32-arm64.exe ${HASH}`,
  "",
].join("\n");

describe("the package", () => {
  it("is the name in the root package.json, with the unscoped command npx runs", () => {
    const { name } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(PACKAGE).toBe(name);
    expect(COMMAND).toBe(name.split("/").at(-1));
  });

  it("names the setup command as npx with the scoped package", () => {
    expect(SETUP_COMMAND).toBe("npx @pedromondek/better-claude-code-telegram");
  });
});

function deps({
  platform = "linux",
  arch = "x64",
  args = [],
  env = {},
  config = null,
  checksums = CHECKSUMS,
  installed = BINARY,
  downloaded = BINARY,
  downloadError = null,
  isTTY = false,
  answers = [],
  askError = null,
  codes = [0, 0],
  spawnError = null,
} = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const asked = [];

  return {
    calls,
    out,
    err,
    asked,
    run: () =>
      run(args, {
        version: VERSION,
        platform,
        arch,
        env,
        isTTY,
        readConfig: () => config,
        readChecksums: () => checksums,
        readInstalled: (name) => {
          calls.push(["readInstalled", name]);

          return installed;
        },
        download: async (url) => {
          calls.push(["download", url]);

          if (downloadError !== null) {
            throw new Error(downloadError);
          }

          return downloaded;
        },
        ask: async (question) => {
          asked.push(question);

          if (askError !== null) {
            throw askError;
          }

          return answers.shift() ?? "";
        },
        writeExecutable: (bytes, name) => {
          calls.push([
            "writeExecutable",
            createHash("sha256").update(bytes).digest("hex"),
            name,
          ]);

          return `/tmp/bcct-shim/${name}`;
        },
        removeExecutable: (path) => {
          calls.push(["removeExecutable", path]);
        },
        spawn: (binary, binaryArgs) => {
          calls.push(["spawn", binary, binaryArgs]);

          if (spawnError !== null) {
            throw spawnError;
          }

          return codes.shift() ?? 0;
        },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      }),
  };
}

describe("PLATFORMS", () => {
  it("are the 6 platforms of the release build, under the names the bcct update uses", () => {
    const binary = readFileSync(
      join(ROOT, "scripts/release-binary.mjs"),
      "utf8",
    );

    expect(PLATFORMS).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-arm64",
      "darwin-x64",
      "win32-x64",
      "win32-arm64",
    ]);
    for (const platform of PLATFORMS) {
      expect(binary).toContain(`asset: "bcct-${platform}`);
    }
  });
});

describe("platformOf", () => {
  it.each([
    ["linux", "x64", "bcct-linux-x64", "bcct"],
    ["linux", "arm64", "bcct-linux-arm64", "bcct"],
    ["darwin", "arm64", "bcct-darwin-arm64", "bcct"],
    ["darwin", "x64", "bcct-darwin-x64", "bcct"],
    ["win32", "x64", "bcct-win32-x64.exe", "bcct.exe"],
    ["win32", "arm64", "bcct-win32-arm64.exe", "bcct.exe"],
  ])(
    "maps %s %s to the asset %s and its package in the @pedromondek scope",
    (os, arch, asset, binary) => {
      expect(platformOf(os, arch)).toEqual({
        name: `${os}-${arch}`,
        asset,
        packageName: `@pedromondek/better-claude-code-telegram-${os}-${arch}`,
        binary,
      });
    },
  );

  it.each([
    ["freebsd", "x64"],
    ["linux", "ia32"],
    ["linux", "riscv64"],
  ])("has no binary for %s %s", (os, arch) => {
    expect(platformOf(os, arch)).toBeNull();
  });
});

describe("expectedHash", () => {
  it("reads the hash of the version and the asset, as the bcct update does, skipping comments and other versions", () => {
    expect(expectedHash(CHECKSUMS, VERSION, "bcct-linux-x64")).toBe(HASH);
  });

  it("finds nothing for an asset or a version that is not listed", () => {
    expect(expectedHash(CHECKSUMS, VERSION, "bcct-darwin-x64")).toBeNull();
    expect(expectedHash(CHECKSUMS, "9.9.9", "bcct-linux-x64")).toBeNull();
  });
});

describe("binaryCommand", () => {
  it.each([
    [[], ["setup"], false],
    [["token"], ["setup", "token"], false],
    [["--set", "wait=4"], ["setup", "--set", "wait=4"], false],
    [["uninstall"], ["uninstall"], false],
    [["uninstall", "0.1.0"], ["uninstall", "0.1.0"], false],
    [["health"], ["health"], false],
    [["health", "--download-binary"], ["health"], true],
    [["--download-binary"], ["setup"], true],
    [["path", "--download-binary"], ["setup", "path"], true],
  ])("turns %j into the bcct command %j", (args, command, download) => {
    expect(binaryCommand(args)).toEqual({ command, download });
  });
});

describe("localeOf", () => {
  it("uses the language saved in the config", () => {
    expect(
      localeOf({ config: { language: "pt-br" }, env: { LANG: "en_US" } }),
    ).toBe("pt-br");
  });

  it.each([
    [{ LC_ALL: "pt_BR.UTF-8" }, "pt-br"],
    [{ LC_MESSAGES: "pt_BR", LANG: "en_US" }, "pt-br"],
    [{ LC_ALL: "", LANG: "pt_BR.UTF-8" }, "pt-br"],
    [{ LANG: "en_US.UTF-8" }, "en-us"],
    [{ LANG: "de_DE" }, "en-us"],
    [{}, "en-us"],
  ])(
    "without a saved language, follows LC_ALL, LC_MESSAGES and LANG (%j)",
    (env, locale) => {
      expect(localeOf({ config: null, env })).toBe(locale);
    },
  );

  it("ignores a saved language it does not know", () => {
    expect(
      localeOf({ config: { language: "fr" }, env: { LANG: "pt_BR" } }),
    ).toBe("pt-br");
  });
});

describe("releaseUrl", () => {
  it("points to the asset of the version on the GitHub Release, as the bcct update downloads it", () => {
    expect(releaseUrl("0.2.0", "bcct-linux-x64")).toBe(
      "https://github.com/pedromondek/better-claude-code-telegram/releases/download/v0.2.0/bcct-linux-x64",
    );
    expect(
      readFileSync(join(ROOT, "rust/crates/bcct/src/update.rs"), "utf8"),
    ).toContain('format!("{}/v{target}/{asset}", self.world.releases_root)');
  });
});

describe("run", () => {
  it("installs the binary of the platform package with its hash, then runs the setup", async () => {
    const shim = deps();

    expect(await shim.run()).toBe(0);
    expect(shim.calls).toEqual([
      ["readInstalled", "@pedromondek/better-claude-code-telegram-linux-x64"],
      ["writeExecutable", HASH, "bcct"],
      [
        "spawn",
        "/tmp/bcct-shim/bcct",
        [
          "self-install",
          "/tmp/bcct-shim/bcct",
          "--sha256",
          HASH,
          "--from",
          "npm",
        ],
      ],
      ["spawn", "/tmp/bcct-shim/bcct", ["setup"]],
      ["removeExecutable", "/tmp/bcct-shim/bcct"],
    ]);
    expect(shim.err).toEqual([]);
  });

  it("passes the step and the uninstall through to the binary", async () => {
    const shim = deps({ args: ["uninstall", "0.1.0"] });

    await shim.run();

    expect(shim.calls.findLast(([name]) => name === "spawn")).toEqual([
      "spawn",
      "/tmp/bcct-shim/bcct",
      ["uninstall", "0.1.0"],
    ]);
  });

  it("returns the exit code of the command", async () => {
    expect(await deps({ codes: [0, 3] }).run()).toBe(3);
  });

  it("stops when the self-install fails, without running the command, and still removes the temporary binary", async () => {
    const shim = deps({ codes: [4] });

    expect(await shim.run()).toBe(4);
    expect(shim.calls.filter(([name]) => name === "spawn")).toHaveLength(1);
    expect(shim.calls.at(-1)).toEqual([
      "removeExecutable",
      "/tmp/bcct-shim/bcct",
    ]);
  });

  it("refuses a binary whose hash is not the one of checksums.txt, installing nothing", async () => {
    const shim = deps({ installed: Buffer.from("other binary") });
    const other = createHash("sha256").update("other binary").digest("hex");

    expect(await shim.run()).toBe(1);
    expect(shim.err).toEqual([
      `✗ bcct-linux-x64 does not match the hash in checksums.txt (expected ${HASH}, got ${other}); nothing was installed.`,
    ]);
    expect(shim.calls.map(([name]) => name)).toEqual(["readInstalled"]);
  });

  it("names the 6 platforms on a machine without a binary", async () => {
    const shim = deps({ platform: "freebsd" });

    expect(await shim.run()).toBe(1);
    expect(shim.err).toEqual([
      "✗ bcct has no binary for freebsd-x64. Supported: linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64, win32-arm64.",
    ]);
  });

  it("stops when checksums.txt has no hash for the asset, which means a broken package", async () => {
    const shim = deps({ checksums: "" });

    expect(await shim.run()).toBe(1);
    expect(shim.err).toEqual([
      "✗ The checksums.txt of @pedromondek/better-claude-code-telegram has no hash for bcct-linux-x64 0.2.0. Reinstall @pedromondek/better-claude-code-telegram.",
    ]);
  });

  it("speaks Portuguese when the saved language is pt-br", async () => {
    const shim = deps({ platform: "freebsd", config: { language: "pt-br" } });

    await shim.run();

    expect(shim.err).toEqual([
      "✗ O bcct não tem binário para freebsd-x64. Disponíveis: linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64, win32-arm64.",
    ]);
  });

  describe("without the platform package", () => {
    const missing = [
      "✗ The package @pedromondek/better-claude-code-telegram-linux-x64, with the bcct binary for this machine, was not installed.",
      "  It is an optional dependency: npm skips it with --omit=optional or optional=false, and some registry mirrors do not serve it.",
    ];
    const manual = [
      "  To install it: run again without --omit=optional, or run again with --download-binary,",
      "  or download https://github.com/pedromondek/better-claude-code-telegram/releases/download/v0.2.0/bcct-linux-x64,",
      `  make it executable and run: <file> self-install <file> --sha256 ${HASH}`,
    ];

    it("outside a terminal only explains and exits 1, downloading nothing", async () => {
      const shim = deps({ installed: null });

      expect(await shim.run()).toBe(1);
      expect(shim.err).toEqual([...missing, ...manual]);
      expect(shim.calls.map(([name]) => name)).toEqual(["readInstalled"]);
    });

    it("with --download-binary downloads from the Release without asking, checks it and installs it as a release download", async () => {
      const shim = deps({ installed: null, args: ["--download-binary"] });

      expect(await shim.run()).toBe(0);
      expect(shim.asked).toEqual([]);
      expect(shim.calls).toEqual([
        ["readInstalled", "@pedromondek/better-claude-code-telegram-linux-x64"],
        [
          "download",
          "https://github.com/pedromondek/better-claude-code-telegram/releases/download/v0.2.0/bcct-linux-x64",
        ],
        ["writeExecutable", HASH, "bcct"],
        [
          "spawn",
          "/tmp/bcct-shim/bcct",
          [
            "self-install",
            "/tmp/bcct-shim/bcct",
            "--sha256",
            HASH,
            "--from",
            "release",
          ],
        ],
        ["spawn", "/tmp/bcct-shim/bcct", ["setup"]],
        ["removeExecutable", "/tmp/bcct-shim/bcct"],
      ]);
      expect(shim.err).toEqual(missing);
    });

    it("in a terminal asks, with no default: an empty answer asks again, and yes downloads", async () => {
      const shim = deps({
        installed: null,
        isTTY: true,
        answers: ["", "  ", "y"],
      });

      expect(await shim.run()).toBe(0);
      expect(shim.asked).toEqual([
        "Download bcct-linux-x64 0.2.0 from the GitHub Release and check it against checksums.txt? [y/n] ",
        "Download bcct-linux-x64 0.2.0 from the GitHub Release and check it against checksums.txt? [y/n] ",
        "Download bcct-linux-x64 0.2.0 from the GitHub Release and check it against checksums.txt? [y/n] ",
      ]);
      expect(shim.calls.map(([name]) => name)).toContain("download");
    });

    it.each(["n", "no", "N", "não", "nao"])(
      "in a terminal, answering %s explains the other ways and exits 1",
      async (answer) => {
        const shim = deps({ installed: null, isTTY: true, answers: [answer] });

        expect(await shim.run()).toBe(1);
        expect(shim.err).toEqual([...missing, ...manual]);
        expect(shim.calls.map(([name]) => name)).toEqual(["readInstalled"]);
      },
    );

    it.each(["y", "yes", "Y", "s", "sim"])(
      "in a terminal, %s downloads",
      async (answer) => {
        const shim = deps({ installed: null, isTTY: true, answers: [answer] });

        expect(await shim.run()).toBe(0);
      },
    );

    it("asks in Portuguese when the language is pt-br", async () => {
      const shim = deps({
        installed: null,
        isTTY: true,
        answers: ["s"],
        env: { LANG: "pt_BR.UTF-8" },
      });

      await shim.run();

      expect(shim.asked).toEqual([
        "Baixar bcct-linux-x64 0.2.0 do GitHub Release e conferir pelo checksums.txt? [s/n] ",
      ]);
    });

    it.each([
      ["Ctrl+C", { LANG: "en_US.UTF-8" }],
      ["Ctrl+D", {}],
    ])(
      "explains the other ways and exits 1 when %s aborts the question",
      async (keys) => {
        const shim = deps({
          installed: null,
          isTTY: true,
          askError: Object.assign(new Error(`Aborted with ${keys}`), {
            name: "AbortError",
            code: "ABORT_ERR",
          }),
        });

        expect(await shim.run()).toBe(1);
        expect(shim.asked).toHaveLength(1);
        expect(shim.err).toEqual([...missing, ...manual]);
        expect(shim.calls.map(([name]) => name)).toEqual(["readInstalled"]);
      },
    );

    it("explains the other ways in Portuguese when the question is aborted", async () => {
      const shim = deps({
        installed: null,
        isTTY: true,
        env: { LANG: "pt_BR.UTF-8" },
        askError: new Error("Aborted with Ctrl+C"),
      });

      expect(await shim.run()).toBe(1);
      expect(shim.err.slice(-3)).toEqual([
        "  Para instalar: rode de novo sem --omit=optional, ou rode de novo com --download-binary,",
        "  ou baixe https://github.com/pedromondek/better-claude-code-telegram/releases/download/v0.2.0/bcct-linux-x64,",
        `  torne o arquivo executável e rode: <arquivo> self-install <arquivo> --sha256 ${HASH}`,
      ]);
    });

    it("refuses a download whose hash is not the one of checksums.txt", async () => {
      const shim = deps({
        installed: null,
        args: ["--download-binary"],
        downloaded: Buffer.from("tampered"),
      });

      expect(await shim.run()).toBe(1);
      expect(shim.err.at(-1)).toMatch(
        /^✗ bcct-linux-x64 does not match the hash in checksums\.txt/u,
      );
      expect(shim.calls.map(([name]) => name)).toEqual([
        "readInstalled",
        "download",
      ]);
    });

    it("explains a download that failed", async () => {
      const shim = deps({
        installed: null,
        args: ["--download-binary"],
        downloadError: "HTTP 404",
      });

      expect(await shim.run()).toBe(1);
      expect(shim.err.at(-1)).toBe(
        "✗ Could not download https://github.com/pedromondek/better-claude-code-telegram/releases/download/v0.2.0/bcct-linux-x64: HTTP 404",
      );
    });
  });

  it("writes and runs the bcct.exe of the win32 package on Windows", async () => {
    const shim = deps({ platform: "win32", arch: "arm64" });

    expect(await shim.run()).toBe(0);
    expect(shim.calls.slice(0, 2)).toEqual([
      ["readInstalled", "@pedromondek/better-claude-code-telegram-win32-arm64"],
      ["writeExecutable", HASH, "bcct.exe"],
    ]);
    expect(shim.calls.at(-2)).toEqual([
      "spawn",
      "/tmp/bcct-shim/bcct.exe",
      ["setup"],
    ]);
  });

  it("routes health to the bcct health command instead of a setup step", async () => {
    const shim = deps({ args: ["health"] });

    expect(await shim.run()).toBe(0);
    expect(shim.calls.at(-2)).toEqual([
      "spawn",
      "/tmp/bcct-shim/bcct",
      ["health"],
    ]);
  });

  it.each([
    [
      "en-us",
      {},
      "✗ Could not run /tmp/bcct-shim/bcct: spawnSync /tmp/bcct-shim/bcct EACCES. If the temporary folder does not allow running programs (noexec), set TMPDIR to one that does.",
    ],
    [
      "pt-br",
      { LANG: "pt_BR.UTF-8" },
      "✗ Não foi possível executar /tmp/bcct-shim/bcct: spawnSync /tmp/bcct-shim/bcct EACCES. Se a pasta temporária não permite executar programas (noexec), aponte o TMPDIR para uma que permita.",
    ],
  ])(
    "explains in %s a binary the system refuses to run and still removes it",
    async (_locale, env, line) => {
      const shim = deps({
        env,
        spawnError: new Error("spawnSync /tmp/bcct-shim/bcct EACCES"),
      });

      expect(await shim.run()).toBe(1);
      expect(shim.err).toEqual([line]);
      expect(shim.calls.filter(([name]) => name === "spawn")).toHaveLength(1);
      expect(shim.calls.at(-1)).toEqual([
        "removeExecutable",
        "/tmp/bcct-shim/bcct",
      ]);
    },
  );

  it("explains a spawn failure that is not an Error with its text", async () => {
    const shim = deps({ spawnError: "EPERM" });

    expect(await shim.run()).toBe(1);
    expect(shim.err[0]).toMatch(
      /^✗ Could not run \/tmp\/bcct-shim\/bcct: EPERM\./u,
    );
  });
});

describe("runBinary", () => {
  function signals() {
    return new EventEmitter();
  }

  it("ignores SIGINT only while the child runs and returns its exit code", () => {
    const emitter = signals();
    const seen = [];
    const childSignals = [];

    const code = runBinary(
      {
        spawnSync: (binary, args, options) => {
          seen.push([binary, args, options, emitter.listenerCount("SIGINT")]);

          return { status: 5, signal: null };
        },
        signals: emitter,
        onSignal: (signal) => childSignals.push(signal),
      },
      "/tmp/bcct-shim/bcct",
      ["setup"],
    );

    expect(code).toBe(5);
    expect(seen).toEqual([
      ["/tmp/bcct-shim/bcct", ["setup"], { stdio: "inherit" }, 1],
    ]);
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(childSignals).toEqual([]);
  });

  it("returns 1 and hands over the signal when the child ends by a signal", () => {
    const emitter = signals();
    const childSignals = [];

    expect(
      runBinary(
        {
          spawnSync: () => ({ status: null, signal: "SIGKILL" }),
          signals: emitter,
          onSignal: (signal) => childSignals.push(signal),
        },
        "bcct",
        [],
      ),
    ).toBe(1);
    expect(childSignals).toEqual(["SIGKILL"]);
  });

  it("throws the error of a child that could not start and stops ignoring SIGINT", () => {
    const emitter = signals();
    const error = new Error("spawnSync bcct EACCES");
    const childSignals = [];

    expect(() =>
      runBinary(
        {
          spawnSync: () => ({ status: null, signal: null, error }),
          signals: emitter,
          onSignal: (signal) => childSignals.push(signal),
        },
        "bcct",
        [],
      ),
    ).toThrow(error);
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(childSignals).toEqual([]);
  });

  const SHIM_ENDING_SCRIPT = [
    'import { spawnSync } from "node:child_process";',
    "const { exitAsChild, runBinary } = await import(process.env.SHIM_URL);",
    "let childSignal = null;",
    'const code = runBinary({ spawnSync, signals: process, onSignal: (signal) => { childSignal = signal; } }, "/bin/sh", ["-c", process.env.SHIM_COMMAND]);',
    "exitAsChild(process, code, childSignal);",
  ].join("\n");

  function shimEnding(command) {
    return spawnSync(
      process.execPath,
      ["--input-type=module", "-e", SHIM_ENDING_SCRIPT],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SHIM_URL: pathToFileURL(SHIM).href,
          SHIM_COMMAND: command,
        },
      },
    );
  }

  it.skipIf(process.platform === "win32")(
    "keeps the shim alive until the child ends when the terminal sends SIGINT",
    () => {
      const result = shimEnding("kill -INT $PPID; sleep 0.2; exit 7");

      expect(result.signal).toBeNull();
      expect(result.status).toBe(7);
    },
  );

  it.skipIf(process.platform === "win32")(
    "ends the shim by SIGINT when the child dies by SIGINT",
    () => {
      const result = shimEnding("kill -INT $$; sleep 1; exit 7");

      expect(result.signal).toBe("SIGINT");
      expect(result.status).toBeNull();
    },
  );
});

describe("exitAsChild", () => {
  function current() {
    const kills = [];

    return {
      pid: 4242,
      exitCode: undefined,
      kills,
      kill: (pid, signal) => kills.push([pid, signal]),
    };
  }

  it("sets the exit code and sends no signal when the child exited by code", () => {
    const shim = current();

    exitAsChild(shim, 7, null);

    expect(shim.exitCode).toBe(7);
    expect(shim.kills).toEqual([]);
  });

  it("sends the signal of the child to itself and keeps the exit code as a fallback", () => {
    const shim = current();

    exitAsChild(shim, 1, "SIGINT");

    expect(shim.exitCode).toBe(1);
    expect(shim.kills).toEqual([[4242, "SIGINT"]]);
  });

  it("keeps the exit code and sends no signal when the child ended by SIGUSR1, which opens the Node inspector", () => {
    const shim = current();

    exitAsChild(shim, 1, "SIGUSR1");

    expect(shim.exitCode).toBe(1);
    expect(shim.kills).toEqual([]);
  });
});
