import { execFileSync } from "node:child_process";

const USAGE =
  "usage: npm run pr:lock (pull request in PR_NUMBER, or every open one without it)";
const PULL_REQUEST_NUMBER = /^[1-9]\d*$/u;

function targets(env, github) {
  const wanted = env.PR_NUMBER ?? "";

  if (wanted === "") {
    return github.openPullRequests();
  }

  if (!PULL_REQUEST_NUMBER.test(wanted)) {
    throw new Error(
      `PR_NUMBER must be the number of a pull request, not "${wanted}"`,
    );
  }

  return [github.pullRequest(Number(wanted))];
}

function lockAll({ env, github, out }) {
  const pullRequests = targets(env, github);

  if (pullRequests.length === 0) {
    out("- no open pull request");
    return;
  }

  for (const { number, locked } of pullRequests) {
    if (locked) {
      out(`- #${number} is already locked`);
      continue;
    }

    github.lock(number);
    out(`✓ #${number} locked`);
  }
}

export function run(args, { env, github, out, err }) {
  if (args.length > 0) {
    err(USAGE);
    return 2;
  }

  try {
    lockAll({ env, github, out });
    return 0;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const summary = ({ number, locked }) => ({ number, locked });

const github = {
  pullRequest: (number) =>
    summary(JSON.parse(gh(["api", `repos/{owner}/{repo}/pulls/${number}`]))),
  openPullRequests: () =>
    JSON.parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/{owner}/{repo}/pulls?state=open&per_page=100",
      ]),
    )
      .flat()
      .map(summary),
  lock: (number) => {
    gh(["pr", "lock", String(number)]);
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
