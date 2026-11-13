import { basename, dirname, join, relative } from "node:path";

const quoted = (files) => files.map((file) => `"${file}"`).join(" ");
const tool = (command) => `sh scripts/mise-exec.sh ${command}`;
const fromRoot = (files) => files.map((file) => relative(process.cwd(), file));

export const scriptTestOf = (file) =>
  join(
    relative(process.cwd(), dirname(file)),
    "__tests__",
    `${basename(file, ".sh")}.test.mjs`,
  );

export default {
  "*": (files) => [
    `secretlint --no-glob ${quoted(files)}`,
    tool(`typos --force-exclude ${quoted(fromRoot(files))}`),
  ],
  "*.{ts,mts,cts,js,mjs,cjs}": (files) => {
    const inFolders = files.filter(
      (file) => dirname(relative(process.cwd(), file)) !== ".",
    );

    return [
      `prettier --write ${quoted(files)}`,
      `oxlint --fix --max-warnings 0 ${quoted(files)}`,
      `eslint --fix --max-warnings 0 --no-warn-ignored ${quoted(files)}`,
      ...(inFolders.length > 0
        ? [`vitest related --run --passWithNoTests ${quoted(inFolders)}`]
        : []),
    ];
  },
  "*.{json,md,yml,yaml}": (files) => [`prettier --write ${quoted(files)}`],
  "{.claude-plugin/marketplace.json,plugins/*/.claude-plugin/plugin.json,plugins/*/hooks/hooks.json,plugins/*/skills/*/SKILL.md}":
    () => ["npm run --silent lint:plugins"],
  "{package.json,package-lock.json,.lockfile-lintrc.json}": (files) =>
    fromRoot(files).some((file) => dirname(file) === ".")
      ? ["npm run --silent lint:lockfile"]
      : [],
  "rust/**/*.rs": (files) => [
    `rustfmt --edition 2024 ${quoted(files)}`,
    "npm run --silent rust:lint",
    "npm run --silent rust:test",
  ],
  "rust/**/{Cargo.toml,Cargo.lock,deny.toml}": () => [
    "npm run --silent rust:deny",
  ],
  ".github/workflows/*.{yml,yaml}": (files) => [
    tool(`actionlint ${quoted(files)}`),
    tool(`zizmor --offline ${quoted(files)}`),
    tool(`pinact run --fix=false --no-api ${quoted(files)}`),
  ],
  ".github/actions/**/action.{yml,yaml}": (files) => [
    tool(`zizmor --offline ${quoted(files)}`),
    tool(`pinact run --fix=false --no-api ${quoted(files)}`),
  ],
  ".github/actionlint.{yml,yaml}": () => [tool("actionlint")],
  "{.husky/*,.husky/**/*.sh}": () => ["npm run --silent test:hooks"],
  "scripts/**/*.sh": (files) => [
    `vitest run --passWithNoTests ${quoted(files.map(scriptTestOf))}`,
  ],
};
