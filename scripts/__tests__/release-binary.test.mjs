import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TARGETS,
  binaryProblems,
  packageBinary,
  run,
  targetOf,
} from "../release-binary.mjs";
import { VERSION_FILES, setVersion } from "../version.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const STATIC_ELF = [
  "",
  "File: bcct",
  "Format: elf64-x86-64",
  "Arch: x86_64",
  "AddressSize: 64bit",
  "LoadName: <Not found>",
  "NeededLibraries [",
  "]",
].join("\n");
const DYNAMIC_ELF = [
  "",
  "File: ls",
  "Format: elf64-x86-64",
  "Arch: x86_64",
  "AddressSize: 64bit",
  "LoadName: <Not found>",
  "NeededLibraries [",
  "  libc.so.6",
  "  libselinux.so.1",
  "]",
].join("\n");
const NO_INTERP =
  "ProgramHeaders [\n  ProgramHeader {\n    Type: PT_LOAD (0x1)\n  }\n]";
const WITH_INTERP =
  "ProgramHeaders [\n  ProgramHeader {\n    Type: PT_INTERP (0x3)\n  }\n]";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-release-binary-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function coff(arch, libraries) {
  return [
    "Format: COFF-ARM64",
    `Arch: ${arch}`,
    "NeededLibraries [",
    ...libraries.map((library) => `  ${library}`),
    "]",
  ].join("\n");
}

describe("TARGETS", () => {
  it("are the 6 native assets, each on its own runner, as the release decided", () => {
    expect(
      TARGETS.map(({ asset, target, runner }) => [asset, target, runner]),
    ).toEqual([
      ["bcct-linux-x64", "x86_64-unknown-linux-musl", "ubuntu-24.04"],
      ["bcct-linux-arm64", "aarch64-unknown-linux-musl", "ubuntu-24.04-arm"],
      ["bcct-darwin-arm64", "aarch64-apple-darwin", "macos-15"],
      ["bcct-darwin-x64", "x86_64-apple-darwin", "macos-15-intel"],
      ["bcct-win32-x64.exe", "x86_64-pc-windows-msvc", "windows-2025"],
      ["bcct-win32-arm64.exe", "aarch64-pc-windows-msvc", "windows-11-arm"],
    ]);
  });

  it("names the assets the bcct update downloads", () => {
    const update = readFileSync(
      join(ROOT, "rust/crates/bcct/src/update.rs"),
      "utf8",
    );

    expect(update).toContain('format!("bcct-{}{extension}", platform())');
  });

  it("refuses a target outside the list", () => {
    expect(() => targetOf("riscv64gc-unknown-linux-musl")).toThrow(
      "unknown target: riscv64gc-unknown-linux-musl",
    );
  });
});

describe("binaryProblems", () => {
  const linux = targetOf("x86_64-unknown-linux-musl");
  const windows = targetOf("aarch64-pc-windows-msvc");

  it("passes a static Linux binary: no needed library and no interpreter", () => {
    expect(
      binaryProblems(linux, { headers: STATIC_ELF, programHeaders: NO_INTERP }),
    ).toEqual([]);
  });

  it("stops a Linux binary that needs shared libraries", () => {
    expect(
      binaryProblems(linux, {
        headers: DYNAMIC_ELF,
        programHeaders: NO_INTERP,
      }),
    ).toEqual(["it needs shared libraries: libc.so.6, libselinux.so.1"]);
  });

  it("stops a Linux binary that asks for a dynamic loader", () => {
    expect(
      binaryProblems(linux, {
        headers: STATIC_ELF,
        programHeaders: WITH_INTERP,
      }),
    ).toEqual(["it asks for a dynamic loader (PT_INTERP)"]);
  });

  it("stops a binary of another architecture", () => {
    expect(
      binaryProblems(targetOf("aarch64-unknown-linux-musl"), {
        headers: STATIC_ELF,
        programHeaders: NO_INTERP,
      }),
    ).toEqual(["it is built for x86_64, not for aarch64"]);
  });

  it("fails loud when llvm-readobj prints neither the architecture nor the needed libraries", () => {
    expect(
      binaryProblems(linux, { headers: "File: bcct", programHeaders: "" }),
    ).toEqual([
      "llvm-readobj printed no Arch line",
      "llvm-readobj printed no NeededLibraries block",
    ]);
  });

  it("passes a Windows binary that imports only system libraries", () => {
    expect(
      binaryProblems(windows, {
        headers: coff("aarch64", ["KERNEL32.dll", "ntdll.dll", "WS2_32.dll"]),
      }),
    ).toEqual([]);
  });

  it.each([
    "VCRUNTIME140.dll",
    "vcruntime140_1.dll",
    "MSVCP140.dll",
    "ucrtbase.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll",
  ])(
    "stops a Windows binary that needs the C runtime (%s), which crt-static leaves out",
    (library) => {
      expect(
        binaryProblems(windows, {
          headers: coff("aarch64", ["KERNEL32.dll", library]),
        }),
      ).toEqual([`it needs the C runtime: ${library}`]);
    },
  );
});

describe("packageBinary", () => {
  function project(version) {
    for (const file of VERSION_FILES) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(join(ROOT, file), join(root, file));
    }
    setVersion(root, version);
  }

  function built(target, name = "bcct", targetDir = join(root, "rust/target")) {
    const file = join(targetDir, target, "release", name);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `binary of ${target}`);

    return file;
  }

  function tools({ version = "bcct 0.2.0", headers = STATIC_ELF } = {}) {
    const asked = [];

    return {
      asked,
      readobj: (args) => {
        asked.push(args);

        return args[0] === "--program-headers" ? NO_INTERP : headers;
      },
      binaryVersion: () => version,
    };
  }

  it("checks the binary, copies it under the asset name and writes its sha256 next to it", () => {
    project("0.2.0");
    const binary = built("x86_64-unknown-linux-musl");
    const deps = tools();

    const result = packageBinary({
      root,
      env: {},
      target: "x86_64-unknown-linux-musl",
      outDir: join(root, "dist"),
      ...deps,
    });
    const sha256 = createHash("sha256")
      .update(readFileSync(binary))
      .digest("hex");

    expect(result).toEqual({ asset: "bcct-linux-x64", sha256 });
    expect(readFileSync(join(root, "dist/bcct-linux-x64"), "utf8")).toBe(
      "binary of x86_64-unknown-linux-musl",
    );
    expect(readFileSync(join(root, "dist/bcct-linux-x64.sha256"), "utf8")).toBe(
      `${sha256}  bcct-linux-x64\n`,
    );
    expect(deps.asked).toEqual([
      ["--file-headers", "--needed-libs", binary],
      ["--program-headers", binary],
    ]);
  });

  it("reads the .exe of a Windows target and skips the program headers, which only ELF has", () => {
    project("0.2.0");
    built("x86_64-pc-windows-msvc", "bcct.exe");
    const deps = tools({ headers: coff("x86_64", ["KERNEL32.dll"]) });

    expect(
      packageBinary({
        root,
        env: {},
        target: "x86_64-pc-windows-msvc",
        outDir: join(root, "dist"),
        ...deps,
      }).asset,
    ).toBe("bcct-win32-x64.exe");
    expect(deps.asked.map(([first]) => first)).toEqual(["--file-headers"]);
  });

  it("reads the version from the first line, since --version also lists the versions installed on the machine", () => {
    project("0.2.0");
    built("x86_64-unknown-linux-musl");

    expect(
      packageBinary({
        root,
        env: {},
        target: "x86_64-unknown-linux-musl",
        outDir: join(root, "dist"),
        ...tools({
          version: "bcct 0.2.0\nInstalled:\n  stable  0.1.0 (active)\n",
        }),
      }).asset,
    ).toBe("bcct-linux-x64");
  });

  it("refuses a binary whose version is not the version of the project, writing nothing", () => {
    project("0.2.0");
    built("x86_64-unknown-linux-musl");

    expect(() =>
      packageBinary({
        root,
        env: {},
        target: "x86_64-unknown-linux-musl",
        outDir: join(root, "dist"),
        ...tools({ version: "bcct 0.1.0" }),
      }),
    ).toThrow(
      "bcct-linux-x64: --version printed 'bcct 0.1.0', not 'bcct 0.2.0'",
    );
  });

  it.each([
    ["an absolute", (dir) => dir],
    ["a relative", () => "build/cargo"],
  ])(
    "reads the binary under %s CARGO_TARGET_DIR instead of rust/target",
    (_kind, setting) => {
      project("0.2.0");
      built("x86_64-unknown-linux-musl");
      const binary = built(
        "x86_64-unknown-linux-musl",
        "bcct",
        join(root, "build/cargo"),
      );
      writeFileSync(binary, "binary of CARGO_TARGET_DIR");
      const deps = tools();

      packageBinary({
        root,
        env: { CARGO_TARGET_DIR: setting(join(root, "build/cargo")) },
        target: "x86_64-unknown-linux-musl",
        outDir: join(root, "dist"),
        ...deps,
      });

      expect(deps.asked[0]).toEqual([
        "--file-headers",
        "--needed-libs",
        binary,
      ]);
      expect(readFileSync(join(root, "dist/bcct-linux-x64"), "utf8")).toBe(
        "binary of CARGO_TARGET_DIR",
      );
    },
  );

  it("refuses a binary with problems, naming every one", () => {
    project("0.2.0");
    built("x86_64-unknown-linux-musl");

    expect(() =>
      packageBinary({
        root,
        env: {},
        target: "x86_64-unknown-linux-musl",
        outDir: join(root, "dist"),
        ...tools({ headers: DYNAMIC_ELF }),
      }),
    ).toThrow(
      "bcct-linux-x64: it needs shared libraries: libc.so.6, libselinux.so.1",
    );
  });
});

describe("run", () => {
  it("prints the asset and its sha256", () => {
    const out = [];
    const err = [];

    const code = run(["x86_64-unknown-linux-musl", "dist"], {
      root,
      packageBinary: ({ target, outDir }) => {
        expect({ target, outDir }).toEqual({
          target: "x86_64-unknown-linux-musl",
          outDir: join(root, "dist"),
        });

        return { asset: "bcct-linux-x64", sha256: "abc" };
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });

    expect({ code, out, err }).toEqual({
      code: 0,
      out: ["✓ bcct-linux-x64 checked and packaged (sha256 abc)"],
      err: [],
    });
  });

  it("exits 1 with the problem", () => {
    const err = [];

    const code = run(["x86_64-unknown-linux-musl", "dist"], {
      root,
      packageBinary: () => {
        throw new Error("bcct-linux-x64: it asks for a dynamic loader");
      },
      out: () => {},
      err: (line) => err.push(line),
    });

    expect({ code, err }).toEqual({
      code: 1,
      err: ["✗ bcct-linux-x64: it asks for a dynamic loader"],
    });
  });

  it.each([[[]], [["x86_64-unknown-linux-musl"]], [["a", "b", "c"]]])(
    "a usage error exits 2 (%j)",
    (args) => {
      const err = [];

      expect(
        run(args, {
          root,
          packageBinary: () => ({}),
          out: () => {},
          err: (line) => err.push(line),
        }),
      ).toBe(2);
      expect(err).toEqual([
        "usage: npm run release:binary -- <target> <output folder>",
      ]);
    },
  );

  it("is the release:binary npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["release:binary"]).toBe("node scripts/release-binary.mjs");
  });
});
