import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { allWorkflows, read } from "../support/workflow.mjs";

const config = parse(read(".github/zizmor.yml"));

const installsOutsideLockfile = (definition) =>
  Object.values(definition.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "")
    .filter((run) => /\bnpm (?:install|i)\b/u.test(run));

const secretsReadBy = (job) => [
  ...new Set(
    [...JSON.stringify(job).matchAll(/secrets\.([A-Z0-9_]+)/gu)]
      .map(([, name]) => name)
      .filter((name) => name !== "GITHUB_TOKEN"),
  ),
];

const dispatchableTasks = () =>
  Object.entries(allWorkflows())
    .filter(
      ([, definition]) =>
        "workflow_call" in definition.on &&
        "workflow_dispatch" in definition.on,
    )
    .map(([file, definition]) => ({ file, definition }));

describe("zizmor.yml: the audits ignored on purpose", () => {
  it("ignores only adhoc-packages in push-checks.yml and concurrency-limits in the tasks", () => {
    expect(config).toEqual({
      rules: {
        "adhoc-packages": { ignore: ["push-checks.yml"] },
        "concurrency-limits": {
          ignore: dispatchableTasks()
            .map(({ file }) => file)
            .toSorted(),
        },
      },
    });
  });

  it("ignores concurrency-limits only in tasks that declare no concurrency, since a group inside a called task would cancel its caller", () => {
    const tasks = dispatchableTasks();

    expect(tasks.map(({ file }) => file).toSorted()).toEqual([
      "audit-workflows.yml",
      "build-binaries.yml",
      "check-rust-platforms.yml",
      "push-checks.yml",
      "report-workflow-audit.yml",
      "verify-release.yml",
    ]);
    expect(
      tasks.filter(({ definition }) => definition.concurrency !== undefined),
    ).toEqual([]);
  });

  it("keeps a single install outside a lockfile in all the workflows, the latest Claude Code in push-checks.yml", () => {
    const installs = Object.entries(allWorkflows()).flatMap(
      ([file, definition]) =>
        installsOutsideLockfile(definition).map((run) => ({ file, run })),
    );

    expect(installs).toEqual([
      {
        file: "push-checks.yml",
        run: "npm install --global @anthropic-ai/claude-code@latest",
      },
    ]);
  });

  it("reads each secret other than GITHUB_TOKEN only in a job with an environment, so secrets-outside-env needs no ignore", () => {
    const readers = Object.entries(allWorkflows()).flatMap(
      ([file, definition]) =>
        Object.entries(definition.jobs).flatMap(([job, body]) =>
          secretsReadBy(body).map((secret) => ({
            file,
            job,
            secret,
            environment: body.environment ?? null,
          })),
        ),
    );

    expect(readers).toEqual([
      {
        file: "prepare-release.yml",
        job: "prepare",
        secret: "RELEASE_APP_PRIVATE_KEY",
        environment: "release",
      },
      {
        file: "release.yml",
        job: "publish",
        secret: "RELEASE_APP_PRIVATE_KEY",
        environment: "release",
      },
      {
        file: "release.yml",
        job: "stable",
        secret: "RELEASE_APP_PRIVATE_KEY",
        environment: "release",
      },
    ]);
    expect(config.rules["secrets-outside-env"]).toBeUndefined();
  });
});
