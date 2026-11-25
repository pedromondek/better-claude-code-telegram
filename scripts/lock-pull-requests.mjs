import {
  CODERABBIT_APP,
  CODERABBIT_CHECK,
  PULL_REQUEST_NUMBER,
  invalidPullRequestNumber,
} from "./pull-request.constants.mjs";
import {
  PULL_REQUESTS_ENDPOINT,
  gh,
  pullRequestSummary,
} from "./pull-request-github.mjs";

const USAGE =
  "usage: npm run pr:lock [-- --lock-only] (every open pull request without PR_NUMBER; PR_NUMBER=<n> npm run pr:lock -- --lock-only locks just that one)";
const LOCK_ONLY = "--lock-only";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const POLL_INTERVAL_MS = 30_000;
const REVIEW_CAP_MINUTES = 20;
const REVIEW_CAP_MS = REVIEW_CAP_MINUTES * 60_000;

const shortSha = (sha) => sha.slice(0, 7);

const invalidHeadSha = (value) =>
  `HEAD_SHA must be the full sha of the head of the pull request, not "${value}"`;

const movedPast = (headSha, { head }) =>
  headSha !== "" && typeof head === "string" && head !== headSha;

const movedOn = (number, { head }) =>
  `- #${number} moved on to ${shortSha(head)}, the run of that push locks it`;

function lockAll({ github, out }) {
  const pullRequests = github.openPullRequests();

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

function codeRabbitState(reviews) {
  if (reviews.length === 0) {
    return { appeared: false, completed: false };
  }

  return {
    appeared: true,
    completed: reviews.every(({ status }) => status === "completed"),
    conclusion: reviews.map(({ conclusion }) => conclusion).join(", "),
  };
}

function capWarning(number, head, appeared) {
  if (appeared) {
    return `::warning::The CodeRabbit review of ${shortSha(head)} did not finish within ${REVIEW_CAP_MINUTES} minutes, so #${number} is locked without it`;
  }

  return `::warning::The CodeRabbit check did not appear on ${shortSha(head)} within ${REVIEW_CAP_MINUTES} minutes, so #${number} is locked without its review`;
}

const codeRabbitRuns = (github, headSha) =>
  github.checkRuns(headSha).filter(({ app }) => app === CODERABBIT_APP);

function awaitCodeRabbit(number, { github, clock, sleep, out, headSha }) {
  const deadline = clock() + REVIEW_CAP_MS;
  let appeared = false;

  out(
    `- waiting for the CodeRabbit review of ${shortSha(headSha)} on #${number}`,
  );

  while (clock() <= deadline) {
    const state = codeRabbitState(codeRabbitRuns(github, headSha));

    if (state.completed) {
      out(
        `✓ CodeRabbit finished on ${shortSha(headSha)} (${state.conclusion})`,
      );
      return false;
    }

    appeared = state.appeared;
    const remaining = deadline - clock();

    if (remaining <= 0) {
      break;
    }

    sleep(Math.min(POLL_INTERVAL_MS, remaining));

    const current = github.pullRequest(number);

    if (movedPast(headSha, current)) {
      out(movedOn(number, current));
      return true;
    }
  }

  out(capWarning(number, headSha, appeared));

  return false;
}

const finishedConclusions = (runs) =>
  runs
    .filter(
      ({ status, conclusion }) =>
        status === "completed" && conclusion !== "skipped",
    )
    .map(({ conclusion }) => conclusion);

function readFinishedConclusions({ github, out, headSha }, skippedWarning) {
  try {
    return finishedConclusions(codeRabbitRuns(github, headSha));
  } catch (error) {
    out(skippedWarning);
    throw error;
  }
}

function reviewOfLocked(number, deps) {
  const { out, headSha } = deps;
  const skippedWarning = `::warning::The push of ${shortSha(headSha)} reached #${number} locked, so CodeRabbit skipped its review; a person can unlock #${number} and comment @coderabbitai review`;
  const conclusions = readFinishedConclusions(deps, skippedWarning);

  if (conclusions.length === 0) {
    out(skippedWarning);
    return false;
  }

  out(
    `- #${number} is already locked and CodeRabbit finished on ${shortSha(headSha)} (${conclusions.join(", ")})`,
  );

  return true;
}

function awaitReview(number, deps) {
  const current = deps.github.pullRequest(number);

  if (movedPast(deps.headSha, current)) {
    deps.out(movedOn(number, current));
    return true;
  }

  if (current.locked) {
    return reviewOfLocked(number, deps);
  }

  return awaitCodeRabbit(number, deps);
}

function lockAgain(number, { github, out, headSha }, failures) {
  let current = { locked: false };

  try {
    current = github.pullRequest(number);
  } catch (error) {
    failures.push(error);
  }

  if (movedPast(headSha, current)) {
    out(movedOn(number, current));
    return;
  }

  if (current.locked) {
    out(`- #${number} is already locked`);
    return;
  }

  try {
    github.lock(number);
    out(`✓ #${number} locked`);
  } catch (error) {
    failures.push(error);
  }
}

function lockPullRequest(wanted, deps, lockOnly) {
  if (!PULL_REQUEST_NUMBER.test(wanted)) {
    return [new Error(invalidPullRequestNumber(wanted))];
  }

  const number = Number(wanted);
  const failures = [];
  let settled = false;

  if (!lockOnly) {
    try {
      settled = awaitReview(number, deps);
    } catch (error) {
      failures.push(error);
    }
  }

  if (!settled) {
    lockAgain(number, deps, failures);
  }

  return failures;
}

function lockAllFailures(deps) {
  try {
    lockAll(deps);
    return [];
  } catch (error) {
    return [error];
  }
}

const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);

export function run(args, { env, github, out, err, clock, sleep }) {
  const lockOnly = args.length === 1 && args[0] === LOCK_ONLY;

  if (args.length > 0 && !lockOnly) {
    err(USAGE);
    return 2;
  }

  const wanted = env.PR_NUMBER ?? "";
  const headSha = env.HEAD_SHA ?? "";

  const lockByHand = lockOnly && headSha === "";

  if (
    PULL_REQUEST_NUMBER.test(wanted) &&
    !lockByHand &&
    !FULL_SHA.test(headSha)
  ) {
    err(`✗ ${invalidHeadSha(headSha)}`);
    return 2;
  }

  const deps = { github, out, clock, sleep, headSha };
  const failures =
    wanted === ""
      ? lockAllFailures(deps)
      : lockPullRequest(wanted, deps, lockOnly);

  for (const error of failures) {
    err(`✗ ${messageOf(error)}`);
  }

  return failures.length === 0 ? 0 : 1;
}

export function githubFrom(runGh) {
  return {
    pullRequest: (number) =>
      pullRequestSummary(
        JSON.parse(runGh(["api", `${PULL_REQUESTS_ENDPOINT}/${number}`])),
      ),
    openPullRequests: () =>
      JSON.parse(
        runGh([
          "api",
          "--paginate",
          "--slurp",
          `${PULL_REQUESTS_ENDPOINT}?state=open&per_page=100`,
        ]),
      )
        .flat()
        .map(pullRequestSummary),
    checkRuns: (sha) =>
      JSON.parse(
        runGh([
          "api",
          `repos/{owner}/{repo}/commits/${sha}/check-runs?check_name=${CODERABBIT_CHECK}&per_page=100`,
        ]),
      ).check_runs.map(({ app, status, conclusion }) => ({
        app: app?.slug,
        status,
        conclusion,
      })),
    lock: (number) => {
      runGh(["pr", "lock", String(number)]);
    },
  };
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    env: process.env,
    github: githubFrom(gh),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    clock: () => Date.now(),
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  });
}
