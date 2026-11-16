import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { RUST_TARGET_DIR, binaryFileName } from "./release.constants.mjs";
import { readVersions } from "./version.mjs";

export const TARGETS = [
  {
    asset: "bcct-linux-x64",
    target: "x86_64-unknown-linux-musl",
    runner: "ubuntu-24.04",
    os: "linux",
    arch: "x86_64",
  },
  {
    asset: "bcct-linux-arm64",
    target: "aarch64-unknown-linux-musl",
    runner: "ubuntu-24.04-arm",
    os: "linux",
    arch: "aarch64",
  },
  {
    asset: "bcct-darwin-arm64",
    target: "aarch64-apple-darwin",
    runner: "macos-15",
    os: "darwin",
    arch: "aarch64",
  },
  {
    asset: "bcct-darwin-x64",
    target: "x86_64-apple-darwin",
    runner: "macos-15-intel",
    os: "darwin",
    arch: "x86_64",
  },
  {
    asset: "bcct-win32-x64.exe",
    target: "x86_64-pc-windows-msvc",
    runner: "windows-2025",
    os: "win32",
    arch: "x86_64",
  },
  {
    asset: "bcct-win32-arm64.exe",
    target: "aarch64-pc-windows-msvc",
    runner: "windows-11-arm",
    os: "win32",
    arch: "aarch64",
  },
];

const USAGE = "usage: npm run release:binary -- <target> <output folder>";
const C_RUNTIME = /^(?:vcruntime|msvcp|ucrtbase|api-ms-win-crt-)/iu;
const ARCH_LINE = /^Arch: (\S+)$/mu;
const NEEDED_BLOCK = /^NeededLibraries \[\n([\s\S]*?)^\]$/mu;

export function targetOf(target) {
  const entry = TARGETS.find((item) => item.target === target);

  if (entry === undefined) {
    throw new Error(`unknown target: ${target}`);
  }

  return entry;
}

function neededLibraries(headers) {
  const block = NEEDED_BLOCK.exec(headers);

  if (block === null) {
    return null;
  }

  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function binaryProblems(entry, { headers, programHeaders = "" }) {
  const problems = [];
  const arch = ARCH_LINE.exec(headers)?.[1] ?? null;
  const needed = neededLibraries(headers);

  if (arch === null) {
    problems.push("llvm-readobj printed no Arch line");
  } else if (arch !== entry.arch) {
    problems.push(`it is built for ${arch}, not for ${entry.arch}`);
  }

  if (needed === null) {
    problems.push("llvm-readobj printed no NeededLibraries block");

    return problems;
  }

  if (entry.os === "linux") {
    if (needed.length > 0) {
      problems.push(`it needs shared libraries: ${needed.join(", ")}`);
    }

    if (programHeaders.includes("PT_INTERP")) {
      problems.push("it asks for a dynamic loader (PT_INTERP)");
    }
  }

  if (entry.os === "win32") {
    for (const library of needed.filter((name) => C_RUNTIME.test(name))) {
      problems.push(`it needs the C runtime: ${library}`);
    }
  }

  return problems;
}

export function sha256Line(sha256, asset) {
  return `${sha256}  ${asset}\n`;
}

export function packageBinary({
  root,
  target,
  outDir,
  readobj,
  binaryVersion,
}) {
  const entry = targetOf(target);
  const binary = join(
    root,
    RUST_TARGET_DIR,
    target,
    "release",
    binaryFileName(entry.os),
  );
  const headers = readobj(["--file-headers", "--needed-libs", binary]);
  const programHeaders =
    entry.os === "linux" ? readobj(["--program-headers", binary]) : "";
  const problems = binaryProblems(entry, { headers, programHeaders });

  if (problems.length > 0) {
    throw new Error(`${entry.asset}: ${problems.join("; ")}`);
  }

  const expected = `bcct ${readVersions(root)[0].version}`;
  const printed = binaryVersion(binary).split("\n")[0].trim();

  if (printed !== expected) {
    throw new Error(
      `${entry.asset}: --version printed '${printed}', not '${expected}'`,
    );
  }

  const sha256 = createHash("sha256")
    .update(readFileSync(binary))
    .digest("hex");

  mkdirSync(outDir, { recursive: true });
  copyFileSync(binary, join(outDir, entry.asset));
  writeFileSync(
    join(outDir, `${entry.asset}.sha256`),
    sha256Line(sha256, entry.asset),
  );

  return { asset: entry.asset, sha256 };
}

export function run(args, { root, packageBinary: pack, out, err }) {
  if (args.length !== 2) {
    err(USAGE);

    return 2;
  }

  const [target, outDir] = args;

  try {
    const { asset, sha256 } = pack({ target, outDir: resolve(root, outDir) });

    out(`✓ ${asset} checked and packaged (sha256 ${sha256})`);

    return 0;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }
}

function llvmReadobj() {
  const rustc = (args) => execFileSync("rustc", args, { encoding: "utf8" });
  const sysroot = rustc(["--print", "sysroot"]).trim();
  const host = /^host: (\S+)$/mu.exec(rustc(["-vV"]))[1];
  const extension = process.platform === "win32" ? ".exe" : "";

  return join(sysroot, "lib/rustlib", host, "bin", `llvm-readobj${extension}`);
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");

  process.exitCode = run(process.argv.slice(2), {
    root,
    packageBinary: (options) => {
      const readobjPath = llvmReadobj();

      return packageBinary({
        root,
        ...options,
        readobj: (args) =>
          execFileSync(readobjPath, args, { encoding: "utf8" }),
        binaryVersion: (binary) =>
          execFileSync(binary, ["--version"], { encoding: "utf8" }),
      });
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
