import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { allWorkflows, read } from "../support/workflow.mjs";

const config = parse(read(".github/zizmor.yml"));

const installsOutsideLockfile = (definition) =>
  Object.values(definition.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "")
    .filter((run) => /\bnpm (?:install|i)\b/u.test(run));

const npmInstallLine = () =>
  read(".github/workflows/release.yml")
    .split("\n")
    .findIndex((line) => line.includes("npm install --global npm@")) + 1;

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
  it("ignores only adhoc-packages in push-checks.yml and on the npm install line of release.yml, and concurrency-limits in the tasks", () => {
    expect(config).toEqual({
      rules: {
        "adhoc-packages": {
          ignore: ["push-checks.yml", `release.yml:${npmInstallLine()}`],
        },
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
      "announce-release.yml",
      "audit-workflows.yml",
      "build-binaries.yml",
      "check-mutation.yml",
      "check-rust-platforms.yml",
      "push-checks.yml",
      "report-workflow-audit.yml",
      "verify-release.yml",
    ]);
    expect(
      tasks.filter(({ definition }) => definition.concurrency !== undefined),
    ).toEqual([]);
  });

  it("keeps two installs outside a lockfile in all the workflows: the latest Claude Code in push-checks.yml and the exact npm that moves dist-tags in release.yml", () => {
    const installs = Object.entries(allWorkflows()).flatMap(
      ([file, definition]) =>
        installsOutsideLockfile(definition).map((run) => ({ file, run })),
    );

    expect(installs).toEqual([
      {
        file: "push-checks.yml",
        run: "npm install --global @anthropic-ai/claude-code@latest",
      },
      { file: "release.yml", run: "npm install --global npm@11.21.3" },
    ]);
  });

  it("points the release.yml exception at its npm install line, so a moved line fails here before zizmor flags it", () => {
    expect(npmInstallLine()).toBeGreaterThan(0);
  });

  it("reads each secret other than GITHUB_TOKEN only in a job with an environment or passes it to the one that has it", () => {
    const readers = Object.entries(allWorkflows()).flatMap(
      ([file, definition]) =>
        Object.entries(definition.jobs).flatMap(([job, body]) =>
          secretsReadBy(body).map((secret) => ({
            file,
            job,
            secret,
            environment: body.environment ?? null,
            calls: body.uses ?? null,
          })),
        ),
    );

    expect(readers).toEqual([
      {
        file: "announce-release.yml",
        job: "announce",
        secret: "TELEGRAM_ANNOUNCE_TOKEN",
        environment: "telegram-announce",
        calls: null,
      },
      {
        file: "prepare-release.yml",
        job: "prepare",
        secret: "RELEASE_APP_PRIVATE_KEY",
        environment: "release",
        calls: null,
      },
      {
        file: "release.yml",
        job: "publish",
        secret: "RELEASE_APP_PRIVATE_KEY",
        environment: "release",
        calls: null,
      },
      {
        file: "release.yml",
        job: "stable",
        secret: "RELEASE_APP_PRIVATE_KEY",
        environment: "release",
        calls: null,
      },
      {
        file: "release.yml",
        job: "announce",
        secret: "TELEGRAM_ANNOUNCE_TOKEN",
        environment: null,
        calls: "$/.github/workflows/announce-release.yml",
      },
    ]);
    expect(config.rules["secrets-outside-env"]).toBeUndefined();
  });
});
