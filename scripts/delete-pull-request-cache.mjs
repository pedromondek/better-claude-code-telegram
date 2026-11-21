import { execFileSync } from "node:child_process";

import {
  PULL_REQUEST_NUMBER,
  invalidPullRequestNumber,
} from "./pull-request.constants.mjs";

const USAGE =
  "usage: npm run ci:cache:delete (the closed pull request in PR_NUMBER)";

export function run(args, { env, github, out, err }) {
  if (args.length > 0) {
    err(USAGE);
    return 2;
  }

  const number = env.PR_NUMBER ?? "";

  if (!PULL_REQUEST_NUMBER.test(number)) {
    err(`✗ ${invalidPullRequestNumber(number)}`);
    return 1;
  }

  const ref = `refs/pull/${number}/merge`;

  try {
    github.deleteCaches(ref);
    out(`✓ caches of ${ref} deleted`);
    return 0;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const github = {
  deleteCaches: (ref) => {
    execFileSync(
      "gh",
      ["cache", "delete", "--all", "--ref", ref, "--succeed-on-no-caches"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  },
};

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    env: process.env,
    github,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
