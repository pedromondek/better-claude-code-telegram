import { execFileSync } from "node:child_process";

import { CI_PASSED_JOB, FAILED_CONCLUSIONS } from "./ci.constants.mjs";

const RUN_ID = /^[1-9]\d*$/u;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;

function runJobs(env, gh) {
  const repo = env.GH_REPO ?? "";
  const runId = env.RUN_ID ?? "";

  if (!REPOSITORY.test(repo)) {
    throw new Error(
      `GH_REPO must name the repository as owner/name, not "${repo}"`,
    );
  }

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

export function run({ env, gh, out, err }) {
  try {
    const failed = notPassing(runJobs(env, gh));

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
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
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
