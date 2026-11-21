import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

const EXECUTABLE = 0o755;
const EPOCH_MS = /\b\d{13}\b/g;

export function sandboxPath(binDir) {
  return `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`;
}

function writeExecutable(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, EXECUTABLE);
}

export function writeFakeBcct(
  file,
  logDir,
  { version = "bcct 9.9.9", versionExit = 0, exit = 0, stdout = "" } = {},
) {
  writeExecutable(
    file,
    [
      'if [ "$1" = --version ]; then',
      `  printf '%s\\n' "$0" >> "${logDir}/probes"`,
      `  cat >> "${logDir}/probe-stdin"`,
      `  printf '%s\\n' '${version}'`,
      `  exit ${versionExit}`,
      "fi",
      `{ printf '%s' "$0|$$"; for arg in "$@"; do printf '|%s' "$arg"; done; printf '\\n'; } >> "${logDir}/calls"`,
      `cat >> "${logDir}/stdin"`,
      `printf '%s\\n' "\${BETTER_CC_TELEGRAM_PLUGIN_DIR:-}" >> "${logDir}/plugin-dir"`,
      `printf '%s' '${stdout}'`,
      "echo bcct-stderr >&2",
      `exit ${exit}`,
    ].join("\n"),
  );
}

export function writeFakeTool(file, logDir, { exit = 0 } = {}) {
  writeExecutable(
    file,
    [
      `{ printf '%s' "$0|$$"; for arg in "$@"; do printf '|%s' "$arg"; done; printf '\\n'; } >> "${logDir}/tool-calls"`,
      `cat >> "${logDir}/tool-stdin"`,
      `exit ${exit}`,
    ].join("\n"),
  );
}

export function readLog(logDir, name) {
  const file = join(logDir, name);

  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function readCalls(logDir, name = "calls") {
  return readLog(logDir, name)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [program, pid, ...args] = line.split("|");

      return { program, pid: Number(pid), args };
    });
}

export function maskTime(text) {
  return text.replaceAll(EPOCH_MS, "<time>");
}

export function treeSnapshot(root) {
  if (!existsSync(root)) return {};

  const snapshot = {};
  const walk = (folder) => {
    for (const name of readdirSync(folder).toSorted()) {
      const path = join(folder, name);
      const stats = lstatSync(path);
      const mode = (stats.mode & 0o777).toString(8);
      const key = maskTime(relative(root, path));

      if (stats.isDirectory()) {
        snapshot[key] = { mode };
        walk(path);
      } else {
        snapshot[key] = { mode, text: maskTime(readFileSync(path, "utf8")) };
      }
    }
  };

  walk(root);

  return snapshot;
}
