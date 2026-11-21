import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function git(args) {
  return spawnSync("git", args, { encoding: "utf8" }).stdout ?? "";
}

function nameList(args) {
  return new Set(git(args).split("\n").filter(Boolean));
}

function changedBy(bin, args, cwd, input) {
  if (!existsSync(bin)) return false;

  const result = spawnSync(bin, args, { cwd, input, encoding: "utf8" });

  return result.status === 0 && result.stdout !== input;
}

function eslintWouldFix(root, file, input) {
  const bin = join(root, "node_modules", ".bin", "eslint");

  if (!existsSync(bin)) return false;

  const result = spawnSync(
    bin,
    ["--fix-dry-run", "--stdin", "--stdin-filename", file, "--format", "json"],
    { cwd: root, input, encoding: "utf8" },
  );

  try {
    const [report] = JSON.parse(result.stdout);

    return typeof report?.output === "string";
  } catch {
    return false;
  }
}

function lintStagedCommands(config, picomatch, root, file) {
  return Object.entries(config).flatMap(([pattern, task]) => {
    const matches = picomatch.isMatch(file, pattern, {
      dot: true,
      matchBase: !pattern.includes("/"),
      posixSlashes: true,
      strictBrackets: true,
    });

    if (!matches) return [];

    return [
      typeof task === "function" ? task([join(root, file)]) : task,
    ].flat();
  });
}

function toolsThatWouldChange(root, file, commands) {
  const staged = git(["show", `:${file}`]);
  const tools = [];
  const prettier = join(root, "node_modules", ".bin", "prettier");

  if (
    commands.some((command) => command.includes("prettier --write")) &&
    changedBy(prettier, ["--stdin-filepath", file], root, staged)
  ) {
    tools.push("prettier");
  }

  if (
    commands.some((command) => command.includes("eslint --fix")) &&
    eslintWouldFix(root, file, staged)
  ) {
    tools.push("eslint --fix");
  }

  return tools;
}

const root = git(["rev-parse", "--show-toplevel"]).trim();
const { default: config } = await import(
  pathToFileURL(join(root, "lint-staged.config.mjs")).href
);
const picomatch = createRequire(
  createRequire(join(root, "package.json")).resolve("lint-staged"),
)("picomatch");
const staged = nameList([
  "diff",
  "--cached",
  "--name-only",
  "--diff-filter=ACMR",
]);
const unstaged = nameList(["diff", "--name-only"]);
const culprits = [...staged]
  .filter((file) => unstaged.has(file))
  .map((file) => ({
    file,
    tools: toolsThatWouldChange(
      root,
      file,
      lintStagedCommands(config, picomatch, root, file),
    ),
  }))
  .filter(({ tools }) => tools.length > 0);

if (culprits.length > 0) {
  const lines = [
    "",
    "✖ pre-commit: the lint-staged tasks would change files that have part of their changes outside the stage, and lint-staged cannot merge the two versions:",
    ...culprits.map(({ file, tools }) => `  - ${file} (${tools.join(", ")})`),
    "  Fix the staged version (see it with `git show :<file>`) or stage the whole file and commit again.",
    `  E.g.: git show :${culprits[0].file}`,
  ];

  console.log(lines.join("\n"));
}
