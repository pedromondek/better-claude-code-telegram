import { describe, expect, it } from "vitest";

import { MERGED_PR_CHOICES } from "../../../scripts/merged-pr.mjs";
import {
  describeTaskContract,
  describeWorkflowSecurity,
  read,
  stepById,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "push-checks.yml";
const definition = workflow(FILE);
const checks = definition.jobs.checks;
const packageScripts = JSON.parse(read("package.json")).scripts;

const indexOf = (job, step) => job.steps.indexOf(step);
const gateStep = stepNamed(checks, "Checks");
const modules = stepById(checks, "modules");

describe("push-checks.yml runs the pre-push on the server, called by ci.yml or by hand", () => {
  it("has the target and the checks jobs only", () => {
    expect(Object.keys(definition.jobs)).toEqual(["target", "checks"]);
  });

  it("runs when called and on manual dispatch only", () => {
    expect(triggers(definition)).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
  });

  describe("merged pull request of the manual run", () => {
    const target = definition.jobs.target;
    const resolve = stepById(target, "target");

    it("lets the manual dispatch pick a merged pull request from the select, or another one by number", () => {
      expect(definition.on.workflow_dispatch.inputs).toEqual({
        pr: {
          description: expect.any(String),
          required: true,
          type: "choice",
          options: MERGED_PR_CHOICES,
        },
        pr_number: {
          description: expect.any(String),
          required: false,
          type: "string",
          default: "",
        },
      });
    });

    it("takes the same two inputs from the caller as optional strings, empty when the event brings the range", () => {
      const optional = {
        description: expect.any(String),
        required: false,
        type: "string",
        default: "",
      };

      expect(definition.on.workflow_call.inputs).toEqual({
        pr: optional,
        pr_number: optional,
      });
    });

    it("resolves the pull request only when one was asked for", () => {
      expect(target.if).toBe("inputs.pr != '' || inputs.pr_number != ''");
    });

    it("reads the history of main with contents: read only, in a short job", () => {
      expect(target["runs-on"]).toMatch(/^ubuntu-/);
      expect(target.permissions).toEqual({ contents: "read" });
      expect(stepUsing(target, "actions/checkout").with["fetch-depth"]).toBe(0);
      expect(
        stepUsing(target, "actions/setup-node").with["node-version-file"],
      ).toBe(".nvmrc");
    });

    it("resolves it with the merged-pr package script, passing the inputs through env", () => {
      expect(resolve.run).toBe("npm run --silent merged-pr");
      expect(resolve.env).toEqual({
        PR_CHOICE: "${{ inputs.pr }}",
        PR_NUMBER: "${{ inputs.pr_number }}",
      });
      expect(packageScripts["merged-pr"]).toBe("node scripts/merged-pr.mjs");
    });

    it("hands the label, the merge commit and the range base to the checks", () => {
      expect(target.outputs).toEqual({
        label: "${{ steps.target.outputs.label }}",
        sha: "${{ steps.target.outputs.sha }}",
        before: "${{ steps.target.outputs.before }}",
      });
    });

    it("runs the checks after it, also when it was skipped, but never after it failed", () => {
      expect(checks.needs).toEqual(["target"]);
      expect(checks.if).toBe(
        "${{ !cancelled() && needs.target.result != 'failure' }}",
      );
    });

    it("names the checks after the pull request when there is one", () => {
      expect(checks.name).toBe(
        "${{ needs.target.outputs.label != '' && format('Checks · {0}', needs.target.outputs.label) || 'Checks (the same as the pre-push)' }}",
      );
    });

    it("checks out the merge commit of the pull request, and the event commit without one", () => {
      expect(stepUsing(checks, "actions/checkout").with.ref).toBe(
        "${{ needs.target.outputs.sha }}",
      );
    });
  });

  it("disables husky and the cargo incremental build in its own environment, which the caller does not pass on", () => {
    expect(definition.env).toEqual({
      HUSKY: "0",
      CARGO_INCREMENTAL: "0",
      CARGO_TERM_COLOR: "always",
    });
  });

  it("runs on ubuntu with contents: read only", () => {
    expect(checks["runs-on"]).toMatch(/^ubuntu-/);
    expect(checks.permissions).toEqual({ contents: "read" });
  });

  it("checks out the whole history, which the pre-push range needs", () => {
    expect(stepUsing(checks, "actions/checkout").with["fetch-depth"]).toBe(0);
  });

  it("sets up Node from the .nvmrc", () => {
    expect(
      stepUsing(checks, "actions/setup-node").with["node-version-file"],
    ).toBe(".nvmrc");
  });

  it("runs the husky pre-push itself, without a parallel list of steps", () => {
    expect(gateStep.run).toMatch(/\| sh \.husky\/pre-push origin ci\b/);
  });

  it("skips only the mutation, which the pre-push already runs on the developer machine", () => {
    expect(gateStep.env.PREPUSH_SKIP_MUTATION).toBe("1");
  });

  it("takes the range base from the chosen merged pull request, then from the pull request base or the event before", () => {
    expect(gateStep.env.BEFORE).toBe(
      "${{ needs.target.outputs.before || github.event.pull_request.base.sha || github.event.before }}",
    );
  });

  it("feeds the pre-push with the HEAD and the base, falling back to the zero SHA", () => {
    expect(gateStep.run).toContain("head=$(git rev-parse HEAD)");
    expect(gateStep.run).toContain(
      'refs/heads/ci %s refs/heads/ci %s\\n\' "$head" "${BEFORE:-0000000000000000000000000000000000000000}"',
    );
  });

  it("exits with the pre-push code, read from PIPESTATUS because of the tee", () => {
    expect(gateStep.run).toContain("set +e");
    expect(gateStep.run).toMatch(/\| tee gate\.log\n/);
    expect(gateStep.run).toContain("code=${PIPESTATUS[1]}");
    expect(gateStep.run.trim().split("\n").at(-1)).toBe('exit "$code"');
  });

  it("writes the verdict and the check lines to the step summary", () => {
    expect(gateStep.run).toContain(
      'echo "### Checks: exit $code" >> "$GITHUB_STEP_SUMMARY"',
    );
    expect(gateStep.run).toContain('gate.log >> "$GITHUB_STEP_SUMMARY"');
  });

  describe("node_modules cache", () => {
    it("restores it with a key made of the runner, the .nvmrc, the package-lock.json and the patches", () => {
      expect(modules.uses).toMatch(/^actions\/cache\/restore@/);
      expect(modules.with.path).toBe("node_modules");
      expect(modules.with.key).toBe(
        "node-modules-${{ runner.os }}-${{ hashFiles('.nvmrc') }}-${{ hashFiles('package-lock.json') }}-${{ hashFiles('patches/**') }}",
      );
    });

    it("runs npm ci only when the restore did not hit", () => {
      const install = stepNamed(checks, "Install dependencies");

      expect(install.run).toBe("npm ci");
      expect(install.if).toBe("steps.modules.outputs.cache-hit != 'true'");
      expect(indexOf(checks, modules)).toBeLessThan(indexOf(checks, install));
    });

    it("saves it only on main and only after a miss, with the key of the restore", () => {
      const save = stepUsing(checks, "actions/cache/save");

      expect(save.if).toBe(
        "github.ref == 'refs/heads/main' && steps.modules.outputs.cache-hit != 'true'",
      );
      expect(save.with.path).toBe("node_modules");
      expect(save.with.key).toBe(
        "${{ steps.modules.outputs.cache-primary-key }}",
      );
      expect(indexOf(checks, save)).toBeGreaterThan(
        indexOf(checks, stepNamed(checks, "Install dependencies")),
      );
    });
  });

  it("keeps the rust-cache of the rust workspace read-only outside main", () => {
    const cache = stepUsing(checks, "Swatinem/rust-cache");

    expect(cache.with.workspaces).toBe("rust");
    expect(cache.with["save-if"]).toBe(
      "${{ github.ref == 'refs/heads/main' }}",
    );
  });

  it("installs the tools and the toolchain before the checks", () => {
    const mise = stepUsing(checks, "jdx/mise-action");
    const toolchain = stepNamed(
      checks,
      "Rust toolchain of rust-toolchain.toml",
    );

    expect(toolchain.run).toBe("rustup toolchain install");
    expect(indexOf(checks, mise)).toBeLessThan(indexOf(checks, gateStep));
    expect(indexOf(checks, toolchain)).toBeLessThan(indexOf(checks, gateStep));
    expect(indexOf(checks, modules)).toBeLessThan(indexOf(checks, gateStep));
  });

  it("installs the latest Claude Code before the checks, so a release that breaks the plugin validation shows at once", () => {
    const claude = stepNamed(
      checks,
      "Latest Claude Code CLI for the plugin manifests",
    );

    expect(claude.run).toBe(
      "npm install --global @anthropic-ai/claude-code@latest",
    );
    expect(indexOf(checks, claude)).toBeLessThan(indexOf(checks, gateStep));
  });

  it("pins the mise version", () => {
    expect(stepUsing(checks, "jdx/mise-action").with.version).toMatch(
      /^\d{4}\.\d{1,2}\.\d+$/,
    );
  });

  describe("Rust tests on the other stage of the version", () => {
    const range = stepById(checks, "other-stage");
    const swap = stepNamed(checks, "Other stage of the version");
    const tests = stepNamed(checks, "Rust tests on the other stage");
    const ifRange =
      "${{ !cancelled() && steps.other-stage.outputs.run == 'true' }}";

    it("asks the ci:rust-other-stage script whether the range of the checks touches rust/", () => {
      expect(range.run).toBe("npm run --silent ci:rust-other-stage");
      expect(range.env).toEqual({ BEFORE: gateStep.env.BEFORE });
      expect(packageScripts["ci:rust-other-stage"]).toBeTypeOf("string");
    });

    it("swaps the stage of the version and runs every Rust test only when the range touches rust/", () => {
      expect(swap.run).toBe("npm run --silent release:version -- swap-stage");
      expect(tests.run).toBe("npm run --silent rust:test -- --no-fail-fast");
      expect(swap.if).toBe(ifRange);
      expect(tests.if).toBe(ifRange);
    });

    it("runs also when the pre-push failed, so one run shows both failures", () => {
      expect(range.if).toBe("${{ !cancelled() }}");
    });

    it("runs after the pre-push, which validates the commit as it is, and swaps before the tests", () => {
      expect(indexOf(checks, gateStep)).toBeLessThan(indexOf(checks, range));
      expect(indexOf(checks, range)).toBeLessThan(indexOf(checks, swap));
      expect(indexOf(checks, swap)).toBeLessThan(indexOf(checks, tests));
      expect(checks.steps.at(-1)).toBe(tests);
    });
  });
});

describeWorkflowSecurity(FILE);
describeTaskContract(FILE);
