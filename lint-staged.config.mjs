import { basename, dirname, join, relative } from "node:path";

const quoted = (files) => files.map((file) => `"${file}"`).join(" ");

export const scriptTestOf = (file) =>
  join(
    relative(process.cwd(), dirname(file)),
    "__tests__",
    `${basename(file, ".sh")}.test.mjs`,
  );

export default {
  "*": (files) => [`secretlint --no-glob ${quoted(files)}`],
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
  "{.husky/*,.husky/**/*.sh}": () => ["npm run --silent test:hooks"],
  "scripts/**/*.sh": (files) => [
    `vitest run --passWithNoTests ${quoted(files.map(scriptTestOf))}`,
  ],
};
