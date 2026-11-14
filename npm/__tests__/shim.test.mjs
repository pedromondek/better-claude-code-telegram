import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PLATFORMS,
  binaryCommand,
  expectedHash,
  localeOf,
  platformOf,
  releaseUrl,
  run,
} from "../shim/shim.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
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
  codes = [0, 0],
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

          return answers.shift() ?? "";
        },
        writeExecutable: (bytes) => {
          calls.push([
            "writeExecutable",
            createHash("sha256").update(bytes).digest("hex"),
          ]);

          return "/tmp/bcct-shim/bcct";
        },
        removeExecutable: (path) => {
          calls.push(["removeExecutable", path]);
        },
        spawn: (binary, binaryArgs) => {
          calls.push(["spawn", binary, binaryArgs]);

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
    "maps %s %s to the asset %s and its unscoped package",
    (os, arch, asset, binary) => {
      expect(platformOf(os, arch)).toEqual({
        name: `${os}-${arch}`,
        asset,
        packageName: `better-claude-code-telegram-${os}-${arch}`,
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
      ["readInstalled", "better-claude-code-telegram-linux-x64"],
      ["writeExecutable", HASH],
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
      "✗ The checksums.txt of better-claude-code-telegram has no hash for bcct-linux-x64 0.2.0. Reinstall better-claude-code-telegram.",
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
      "✗ The package better-claude-code-telegram-linux-x64, with the bcct binary for this machine, was not installed.",
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
        ["readInstalled", "better-claude-code-telegram-linux-x64"],
        [
          "download",
          "https://github.com/pedromondek/better-claude-code-telegram/releases/download/v0.2.0/bcct-linux-x64",
        ],
        ["writeExecutable", HASH],
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

  it("names the .exe of Windows", async () => {
    const shim = deps({ platform: "win32", arch: "arm64" });

    await shim.run();

    expect(shim.calls[0]).toEqual([
      "readInstalled",
      "better-claude-code-telegram-win32-arm64",
    ]);
  });
});
