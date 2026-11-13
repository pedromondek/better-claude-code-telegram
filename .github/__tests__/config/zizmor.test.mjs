import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { allWorkflows, read } from "../support/workflow.mjs";

const config = parse(read(".github/zizmor.yml"));

const installsOutsideLockfile = (definition) =>
  Object.values(definition.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "")
    .filter((run) => /\bnpm (?:install|i)\b/u.test(run));

describe("zizmor.yml: the audits ignored on purpose", () => {
  it("ignores only adhoc-packages, and only in push-checks.yml", () => {
    expect(config).toEqual({
      rules: { "adhoc-packages": { ignore: ["push-checks.yml"] } },
    });
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
});
