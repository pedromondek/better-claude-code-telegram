import { describe, expect, it } from "vitest";

import {
  describeTaskContract,
  describeWorkflowSecurity,
  read,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "check-mutation.yml";
const definition = workflow(FILE);
const { plan, rust, outcomes, stryker } = definition.jobs;
const packageScripts = JSON.parse(read("package.json")).scripts;
const MUTANTS_KEY =
  "rust-mutants-${{ github.head_ref || github.ref_name }}-${{ github.sha }}";

describe("check-mutation.yml mutates the range in the CI: Rust in shards, with the mutants already caught, and Stryker in one job", () => {
  it("has the plan, the shards, the caught mutants and the Stryker jobs only", () => {
    expect(Object.keys(definition.jobs)).toEqual([
      "plan",
      "rust",
      "outcomes",
      "stryker",
    ]);
  });

  it("runs when called with the base of the range and on manual dispatch, from scratch by default", () => {
    expect(triggers(definition)).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(Object.keys(definition.on.workflow_call.inputs)).toEqual([
      "before",
      "full",
    ]);
    expect(definition.on.workflow_call.inputs.full.default).toBe(false);
    expect(definition.on.workflow_dispatch.inputs.full.default).toBe(true);
  });

  it("gives every job contents: read only", () => {
    for (const job of Object.values(definition.jobs)) {
      expect(job.permissions).toEqual({ contents: "read" });
    }
  });

  it("plans with the full history and the mutants caught by earlier runs of the branch, then of main", () => {
    const restore = stepUsing(plan, "actions/cache/restore");

    expect(stepUsing(plan, "actions/checkout").with["fetch-depth"]).toBe(0);
    expect(restore.with.path).toBe("rust/mutants.out");
    expect(restore.with.key).toBe(MUTANTS_KEY);
    expect(restore.with["restore-keys"]).toBe(
      "rust-mutants-${{ github.head_ref || github.ref_name }}-\nrust-mutants-main-\n",
    );
    expect(stepNamed(plan, "Plan")).toMatchObject({
      run: "npm run --silent rust:mutation:ci -- plan",
      env: {
        MUTATION_BEFORE: "${{ inputs.before }}",
        RUST_MUTATION_FULL: "${{ inputs.full }}",
      },
    });
    expect(plan.outputs).toEqual({
      count: "${{ steps.plan.outputs.count }}",
      shards: "${{ steps.plan.outputs.shards }}",
    });
  });

  it("gives every shard the same plan, since cargo-mutants skips the caught mutants before it splits the shards", () => {
    expect(rust.needs).toEqual(["plan"]);
    expect(rust.if).toBe("needs.plan.outputs.count != '0'");
    expect(rust.strategy).toEqual({
      "fail-fast": false,
      matrix: { shard: "${{ fromJSON(needs.plan.outputs.shards) }}" },
    });
    expect(stepUsing(rust, "actions/download-artifact").with.name).toBe(
      "rust-mutation-plan",
    );
    expect(stepNamed(rust, "Shard")).toMatchObject({
      run: "npm run --silent rust:mutation:ci -- shard",
      env: {
        RUST_MUTATION_SHARD: "${{ matrix.shard }}/${{ strategy.job-total }}",
      },
    });
  });

  it("keeps each shard under the 6h job limit of GitHub and uploads its outcomes even when it fails", () => {
    expect(rust["timeout-minutes"]).toBeLessThan(360);
    expect(stepUsing(rust, "actions/upload-artifact").if).toBe("always()");
  });

  it("installs only cargo-mutants and nextest from mise.lock where it runs cargo-mutants", () => {
    for (const job of [plan, rust]) {
      expect(stepUsing(job, "jdx/mise-action").with.install_args).toBe(
        "github:sourcefrog/cargo-mutants github:nextest-rs/nextest",
      );
    }
  });

  it("merges the caught mutants of the plan and of every shard and saves them for the next run of the branch", () => {
    expect(outcomes.needs).toEqual(["plan", "rust"]);
    expect(outcomes.if).toBe(
      "${{ !cancelled() && needs.plan.outputs.count != '0' }}",
    );
    expect(stepNamed(outcomes, "Merge").run).toBe(
      "npm run --silent rust:mutation:ci -- merge artifacts/rust-mutation-plan/outcomes artifacts/rust-mutants-shard-*",
    );
    expect(stepUsing(outcomes, "actions/cache/save").with).toEqual({
      path: "rust/mutants.out",
      key: MUTANTS_KEY,
    });
  });

  it("mutates the TypeScript with the incremental of main, saved only on main", () => {
    const restore = stepNamed(stryker, "Incremental of the last mutation");
    const save = stepUsing(stryker, "actions/cache/save");

    expect(stepUsing(stryker, "actions/checkout").with["fetch-depth"]).toBe(0);
    expect(restore.with).toEqual({
      path: "reports/stryker-incremental.json",
      key: "stryker-incremental-${{ github.sha }}",
      "restore-keys": "stryker-incremental-",
    });
    expect(stepNamed(stryker, "Mutation")).toMatchObject({
      run: "npm run --silent test:mutation:prepush",
      env: { MUTATION_BEFORE: "${{ inputs.before }}" },
    });
    expect(save.if).toBe("github.ref == 'refs/heads/main'");
  });

  it("cites only package scripts that exist", () => {
    for (const job of Object.values(definition.jobs)) {
      for (const run of job.steps.map((step) => step.run).filter(Boolean)) {
        const script = /^npm run --silent (\S+)/.exec(run)?.[1];
        if (script === undefined) continue;
        expect({ script, command: typeof packageScripts[script] }).toEqual({
          script,
          command: "string",
        });
      }
    }
  });
});

describeTaskContract(FILE);
describeWorkflowSecurity(FILE);
