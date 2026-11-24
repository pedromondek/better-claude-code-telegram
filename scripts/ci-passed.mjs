import { execFileSync } from "node:child_process";

import {
  CI_PASSED_JOB,
  FAILED_CONCLUSIONS,
  NO_RUNNER_ANNOTATION_LEVEL,
  NO_RUNNER_ANNOTATION_MESSAGE,
  NO_RUNNER_CONCLUSION,
  NO_RUNNER_WARNING,
} from "./ci.constants.mjs";

const RUN_ID = /^[1-9]\d*$/u;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function checkedRepository(env) {
  const repo = env.GH_REPO ?? "";

  if (!REPOSITORY.test(repo)) {
    throw new Error(
      `GH_REPO must name the repository as owner/name, not "${repo}"`,
    );
  }

  return repo;
}

function runJobs(repo, env, gh) {
  const runId = env.RUN_ID ?? "";

  if (!RUN_ID.test(runId)) {
    throw new Error(`RUN_ID must be the id of a workflow run, not "${runId}"`);
  }

  const pages = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    ]),
  );

  return pages.flatMap((page) => page.jobs);
}

function notPassing(jobs) {
  return jobs.filter(
    (job) =>
      job.name !== CI_PASSED_JOB &&
      job.status === "completed" &&
      FAILED_CONCLUSIONS.includes(job.conclusion),
  );
}

function endedBeforeAnyRunner(job) {
  return (
    job.conclusion === NO_RUNNER_CONCLUSION &&
    job.steps?.length === 0 &&
    job.runner_id === 0
  );
}

function annotatedAsNoRunner(repo, job, gh) {
  const pages = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/check-runs/${job.id}/annotations?per_page=100`,
    ]),
  );

  return pages
    .flat()
    .some(
      (annotation) =>
        annotation.annotation_level === NO_RUNNER_ANNOTATION_LEVEL &&
        annotation.message.includes(NO_RUNNER_ANNOTATION_MESSAGE),
    );
}

function gotNoRunner(repo, job, gh, err) {
  if (!endedBeforeAnyRunner(job)) return false;

  try {
    return annotatedAsNoRunner(repo, job, gh);
  } catch (error) {
    err(`✗ Could not read the annotations of ${job.name}: ${messageOf(error)}`);
    return false;
  }
}

export function run({ env, gh, out, err }) {
  try {
    const repo = checkedRepository(env);
    const failed = [];

    for (const job of notPassing(runJobs(repo, env, gh))) {
      if (gotNoRunner(repo, job, gh, err)) {
        out(`::warning::${job.name} ${NO_RUNNER_WARNING}.`);
      } else {
        failed.push(job);
      }
    }

    if (failed.length === 0) {
      out("✓ Every finished job of the run passed or was skipped.");
      return 0;
    }

    const count = failed.length === 1 ? "1 job" : `${failed.length} jobs`;

    err(
      [
        `✗ ${count} of the run did not pass:`,
        ...failed.map((job) => `  - ${job.name}: ${job.conclusion}`),
      ].join("\n"),
    );
    return 1;
  } catch (error) {
    err(`✗ ${messageOf(error)}`);
    return 1;
  }
}

function ghCli(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

if (import.meta.main) {
  process.exitCode = run({
    env: process.env,
    gh: ghCli,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
