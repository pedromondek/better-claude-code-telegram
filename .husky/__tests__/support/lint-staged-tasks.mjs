import { createRequire } from "node:module";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..", "..");

const { default: config } = await import(join(ROOT, "lint-staged.config.mjs"));
const picomatch = createRequire(
  createRequire(join(ROOT, "package.json")).resolve("lint-staged"),
)("picomatch");

export function tasksForFiles(relativeFiles) {
  return Object.entries(config).flatMap(([glob, task]) => {
    const matched = relativeFiles.filter((file) =>
      picomatch.isMatch(file, glob, {
        dot: true,
        matchBase: !glob.includes("/"),
        posixSlashes: true,
        strictBrackets: true,
      }),
    );

    if (matched.length === 0) return [];

    return [
      typeof task === "function"
        ? task(matched.map((file) => join(ROOT, file)))
        : task,
    ].flat();
  });
}

export function tasksFor(relativeFile) {
  return tasksForFiles([relativeFile]);
}
