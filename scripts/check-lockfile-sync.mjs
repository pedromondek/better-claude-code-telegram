import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const BUNDLED_NPM = join(dirname(process.execPath), "npm");
const NPM_BIN = existsSync(BUNDLED_NPM) ? BUNDLED_NPM : "npm";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function rootMirrorProblems(manifest, lockRoot) {
  const problems = [];

  for (const section of DEPENDENCY_SECTIONS) {
    const declared = manifest[section] ?? {};
    const locked = lockRoot[section] ?? {};
    const names = new Set([...Object.keys(declared), ...Object.keys(locked)]);

    for (const name of [...names].toSorted()) {
      if (declared[name] === locked[name]) continue;

      problems.push(
        `${section}.${name}: package.json ${JSON.stringify(declared[name] ?? null)} × package-lock.json ${JSON.stringify(locked[name] ?? null)}`,
      );
    }
  }

  return problems;
}

export function summarizeNpmCiError(stderr) {
  const lines = stderr
    .split("\n")
    .filter((line) => line.startsWith("npm error"))
    .map((line) => line.slice("npm error".length).trim())
    .filter(
      (line) => !line.startsWith("code ") && !line.startsWith("A complete log"),
    );
  const start = lines.findIndex((line) => line !== "");

  if (start === -1) return [];

  const end = lines.indexOf("", start);
  const headline = lines.slice(start, end === -1 ? undefined : end);
  const details = lines.filter(
    (line) => /^(?:Invalid|Missing):/u.test(line) && !headline.includes(line),
  );

  return [...headline, ...details];
}

function npmCiDryRun(dir) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      NPM_BIN,
      [
        "ci",
        "--dry-run",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      { cwd: dir, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => resolvePromise(["npm could not be run"]));
    child.on("close", (code) => {
      if (code === 0) return resolvePromise([]);

      const summary = summarizeNpmCiError(stderr);

      resolvePromise(
        summary.length > 0 ? summary : [`npm ci exited with ${code}`],
      );
    });
  });
}

export async function checkLockfileSync(dir) {
  const manifestFile = join(dir, "package.json");
  const lockFile = join(dir, "package-lock.json");

  if (!existsSync(manifestFile)) return { dir, problems: [] };
  if (!existsSync(lockFile)) {
    return { dir, problems: ["package-lock.json is missing"] };
  }

  const manifest = readJson(manifestFile);
  const lock = readJson(lockFile);

  if (manifest === null)
    return { dir, problems: ["package.json is unreadable"] };
  if (lock === null) {
    return { dir, problems: ["package-lock.json is unreadable"] };
  }

  const mirror = rootMirrorProblems(manifest, lock.packages?.[""] ?? {});

  if (mirror.length > 0) return { dir, problems: mirror };

  return { dir, problems: await npmCiDryRun(dir) };
}

export function formatReport(results, baseDir) {
  return results
    .filter((result) => result.problems.length > 0)
    .map((result) =>
      [
        `${relative(baseDir, result.dir) || "."}: package.json and package-lock.json are out of sync`,
        ...result.problems.map((problem) => `  - ${problem}`),
        "  Run npm install to update the lock, then stage both files.",
      ].join("\n"),
    )
    .join("\n");
}

if (import.meta.main) {
  const baseDir = process.cwd();
  const dirs = (process.argv.length > 2 ? process.argv.slice(2) : ["."]).map(
    (dir) => resolve(baseDir, dir),
  );
  const results = await Promise.all(dirs.map(checkLockfileSync));
  const report = formatReport(results, baseDir);

  if (report !== "") {
    console.error(report);
    process.exitCode = 1;
  }
}
