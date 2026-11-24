import { execFileSync } from "node:child_process";

import { CODERABBIT_CHECK, LOCK_WORKFLOW } from "./pull-request.constants.mjs";
import {
  PULL_REQUESTS_ENDPOINT,
  createGh,
  pullRequestSummary,
} from "./pull-request-github.mjs";

export const UNLOCK_GH_TIMEOUT_MS = 15_000;

const USAGE = "usage: npm run pr:unlock -- <branch>...";
const SKIP_VARIABLES = ["CI", "PREPUSH_SKIP_PR_UNLOCK"];

const isSet = (value) => (value ?? "") !== "";

const firstLine = (text) => text.trim().split("\n")[0];

function reasonOf(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  if (error.code === "ENOENT") {
    return "gh is not installed";
  }

  if (error.code === "ETIMEDOUT") {
    return `gh did not answer within ${UNLOCK_GH_TIMEOUT_MS / 1000} seconds`;
  }

  const printed = firstLine(String(error.stderr ?? ""));

  return printed === "" ? firstLine(error.message) : printed;
}

function unlockBranch(branch, { github, out }) {
  try {
    const pullRequests = github.openPullRequestsOf(branch);

    if (pullRequests.length === 0) {
      out(`- no open pull request from ${branch}`);
      return;
    }

    for (const { number, locked } of pullRequests) {
      if (!locked) {
        out(`- #${number} is not locked`);
        continue;
      }

      github.unlock(number);
      out(`✓ #${number} unlocked, so ${CODERABBIT_CHECK} reviews this push`);
      out(
        `  if this push does not reach GitHub, lock it again with: gh workflow run ${LOCK_WORKFLOW}`,
      );
    }
  } catch (error) {
    out(`⚠ the pull request of ${branch} stays as it is: ${reasonOf(error)}`);
  }
}

export function run(branches, { env, github, out, err }) {
  if (SKIP_VARIABLES.some((name) => isSet(env[name]))) {
    return 0;
  }

  if (branches.length === 0) {
    err(USAGE);
    return 2;
  }

  for (const branch of branches) {
    unlockBranch(branch, { github, out });
  }

  return 0;
}

export function githubFrom(runGh) {
  return {
    openPullRequestsOf: (branch) =>
      JSON.parse(
        runGh([
          "api",
          `${PULL_REQUESTS_ENDPOINT}?state=open&head={owner}:${encodeURIComponent(branch)}&per_page=100`,
        ]),
      ).map(pullRequestSummary),
    unlock: (number) => {
      runGh([
        "api",
        "--method",
        "DELETE",
        `repos/{owner}/{repo}/issues/${number}/lock`,
      ]);
    },
  };
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    env: process.env,
    github: githubFrom(createGh(execFileSync, UNLOCK_GH_TIMEOUT_MS)),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
