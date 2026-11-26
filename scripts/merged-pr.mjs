import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { git } from "./git.mjs";

export const MERGED_PR_CHOICES = [
  "Last merged PR",
  "Second to last merged PR",
  "Third to last merged PR",
];

export const MERGE_LOG_FORMAT = "--format=%H%x1f%P%x1f%s%x1f%b%x1e";

const MERGE_SUBJECT = /^Merge pull request #(\d+) from (?:[^/\s]+\/(\S+))?/;
const RELEASE_BRANCH_PREFIX = "release/v";
const LOG_DEPTH = "200";

export function parseMerges(log) {
  return log
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter(Boolean)
    .flatMap((entry) => {
      const [sha, parents = "", subject = "", body = ""] = entry.split("\x1f");
      const match = MERGE_SUBJECT.exec(subject);

      if (!match) return [];

      return [
        {
          number: Number(match[1]),
          title:
            body
              .split("\n")
              .map((line) => line.trim())
              .find(Boolean) ?? "",
          branch: match[2] ?? "",
          sha,
          before: parents.split(" ")[0],
        },
      ];
    });
}

export function pickMergedPr(merges, { choice, number = "", sha = "" }) {
  const wanted = number.trim();
  const pushed = sha.trim();

  if (wanted) {
    if (!/^\d+$/.test(wanted)) {
      throw new Error(`Invalid pull request number: "${wanted}".`);
    }

    const found = merges.find((merge) => merge.number === Number(wanted));

    if (!found)
      throw new Error(`Pull request #${wanted} was not merged into main.`);

    return found;
  }

  if (pushed) {
    const found = merges.find((merge) => merge.sha === pushed);

    if (!found)
      throw new Error(
        `The pushed commit ${pushed} is not a pull request merge of main.`,
      );

    return found;
  }

  const index = MERGED_PR_CHOICES.indexOf(choice);

  if (index === -1)
    throw new Error(`Unknown pull request choice: "${choice}".`);

  const found = merges.at(index);

  if (!found) throw new Error(`Main has no "${choice}" yet.`);

  return found;
}

export function mergedPrTarget(merge) {
  return {
    number: merge.number,
    label: merge.title
      ? `#${merge.number} - ${merge.title}`
      : `#${merge.number}`,
    sha: merge.sha,
    before: merge.before,
    release: merge.branch.startsWith(RELEASE_BRANCH_PREFIX),
  };
}

function main(env) {
  const merges = parseMerges(
    git([
      "log",
      "--first-parent",
      "--merges",
      `-${LOG_DEPTH}`,
      MERGE_LOG_FORMAT,
      "HEAD",
    ]),
  );
  const target = mergedPrTarget(
    pickMergedPr(merges, {
      choice: env.PR_CHOICE,
      number: env.PR_NUMBER,
      sha: env.PR_SHA,
    }),
  );

  appendFileSync(
    env.GITHUB_OUTPUT,
    [
      `number=${target.number}`,
      `label=${target.label}`,
      `sha=${target.sha}`,
      `before=${target.before}`,
      `release=${target.release}`,
      "",
    ].join("\n"),
  );

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `PR ${target.label} · range ${target.before.slice(0, 7)}..${target.sha.slice(0, 7)}\n`,
    );
  }
}

const entryPoint = process.argv[1];

if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    main(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
