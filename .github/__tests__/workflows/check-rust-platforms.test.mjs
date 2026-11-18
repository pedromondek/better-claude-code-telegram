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

const FILE = "check-rust-platforms.yml";
const definition = workflow(FILE);
const rust = definition.jobs.rust;
const packageScripts = JSON.parse(read("package.json")).scripts;
const matrixOs = rust.strategy.matrix.os;

const indexOf = (job, step) => job.steps.indexOf(step);

describe("check-rust-platforms.yml runs clippy and the Rust tests on macOS and Windows, called by ci.yml or by hand", () => {
  it("has the rust job only", () => {
    expect(Object.keys(definition.jobs)).toEqual(["rust"]);
  });

  it("runs when called and on manual dispatch, with no input", () => {
    expect(triggers(definition)).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(definition.on.workflow_call ?? null).toBeNull();
    expect(definition.on.workflow_dispatch ?? null).toBeNull();
  });

  it("turns off the cargo incremental build and keeps the colors in its own environment, which the caller does not pass on", () => {
    expect(definition.env).toEqual({
      CARGO_INCREMENTAL: "0",
      CARGO_TERM_COLOR: "always",
    });
  });

  it("runs on the matrix os with contents: read only", () => {
    expect(rust["runs-on"]).toBe("${{ matrix.os }}");
    expect(rust.permissions).toEqual({ contents: "read" });
  });

  it("covers exactly macOS and Windows, since the Linux checks already run the whole pre-push", () => {
    expect(matrixOs).toHaveLength(2);
    expect(matrixOs.filter((os) => os.startsWith("macos-"))).toHaveLength(1);
    expect(matrixOs.filter((os) => os.startsWith("windows-"))).toHaveLength(1);
  });

  it("lets one operating system finish when the other fails", () => {
    expect(rust.strategy["fail-fast"]).toBe(false);
  });

  it("runs clippy and the tests by the package scripts, quietly", () => {
    const runs = rust.steps.map((step) => step.run).filter(Boolean);

    expect(runs).toContain("npm run --silent rust:clippy");
    expect(runs).toContain("npm run --silent rust:test -- --no-fail-fast");
  });

  it("runs every test of the platform instead of stopping at the first failure, so one run shows them all", () => {
    expect(stepNamed(rust, "Tests").run).toContain("--no-fail-fast");
  });

  it("cites only package scripts that exist", () => {
    for (const run of rust.steps.map((step) => step.run).filter(Boolean)) {
      const script = /^npm run --silent (\S+)(?: -- .+)?$/.exec(run)?.[1];
      if (script === undefined) continue;
      expect({ script, command: typeof packageScripts[script] }).toEqual({
        script,
        command: "string",
      });
    }
  });

  it("runs clippy and the tests only after the toolchain, the mise tools and the cache", () => {
    const clippy = stepNamed(rust, "Clippy");
    const tests = stepNamed(rust, "Tests");
    const before = [
      stepUsing(rust, "jdx/mise-action"),
      stepNamed(rust, "Rust toolchain of rust-toolchain.toml"),
      stepUsing(rust, "Swatinem/rust-cache"),
    ];

    for (const step of before) {
      expect(indexOf(rust, step)).toBeLessThan(indexOf(rust, clippy));
      expect(indexOf(rust, step)).toBeLessThan(indexOf(rust, tests));
    }
    expect(indexOf(rust, clippy)).toBeLessThan(indexOf(rust, tests));
  });

  it("installs only nextest through mise, since clippy and the tests need nothing else", () => {
    const mise = stepUsing(rust, "jdx/mise-action");

    expect(mise.with.install_args).toBe("github:nextest-rs/nextest");
    expect(mise.with.version).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
  });

  it("keeps the rust-cache read-only outside main", () => {
    const cache = stepUsing(rust, "Swatinem/rust-cache");

    expect(cache.with.workspaces).toBe("rust");
    expect(cache.with["save-if"]).toBe(
      "${{ github.ref == 'refs/heads/main' }}",
    );
  });

  it("does not restore or save the node_modules cache, since no step needs them", () => {
    expect(stepUsing(rust, "actions/cache/restore")).toBeUndefined();
    expect(stepUsing(rust, "actions/cache/save")).toBeUndefined();
    expect(rust.steps.some((step) => /npm ci/.test(step.run ?? ""))).toBe(
      false,
    );
  });
});

describeWorkflowSecurity(FILE);
describeTaskContract(FILE);
