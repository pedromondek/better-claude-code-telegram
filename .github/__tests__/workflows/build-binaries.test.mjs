import { describe, expect, it } from "vitest";

import { TARGETS } from "../../../scripts/release-binary.mjs";
import {
  describeTaskContract,
  describeWorkflowSecurity,
  read,
  stepNamed,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "build-binaries.yml";
const definition = workflow(FILE);
const build = definition.jobs.build;
const packageScripts = JSON.parse(read("package.json")).scripts;

describe("build-binaries.yml builds the 6 native binaries, checks each one and hands them over as artifacts", () => {
  it("has the build job only", () => {
    expect(Object.keys(definition.jobs)).toEqual(["build"]);
  });

  it("is called by the release workflow and can be dispatched alone, which builds without publishing anything", () => {
    expect(triggers(definition)).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(definition.on.workflow_dispatch ?? null).toBeNull();
  });

  it("attests only when the release asks, through an input that is off by default, and builds the commit the release names", () => {
    expect(definition.on.workflow_call.inputs).toEqual({
      attest: {
        description: expect.any(String),
        required: false,
        type: "boolean",
        default: false,
      },
      ref: {
        description: expect.any(String),
        required: false,
        type: "string",
        default: "",
      },
    });
    expect(stepUsing(build, "actions/checkout").with).toEqual({
      ref: "${{ inputs.ref }}",
      "persist-credentials": false,
    });
  });

  it("asks only for what the attestation needs besides reading the code", () => {
    expect(build.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
  });

  it("attests the binary right after it is built and checked, with actions/attest, as the GitHub docs show", () => {
    const step = stepUsing(build, "actions/attest");

    expect(step.name).toBe("Attest");
    expect(step.if).toBe("inputs.attest");
    expect(step.with).toEqual({ "subject-path": "dist/${{ matrix.asset }}" });
  });

  it("builds every target of scripts/release-binary.mjs on its own native runner, and one failing target never cancels the others", () => {
    expect(build.strategy["fail-fast"]).toBe(false);
    expect(build.strategy.matrix).toEqual({
      include: TARGETS.map(({ asset, target, runner }) => ({
        asset,
        target,
        runner,
      })),
    });
    expect(build["runs-on"]).toBe("${{ matrix.runner }}");
    expect(build.name).toBe("Build ${{ matrix.asset }}");
  });

  it("installs the pinned toolchain and the target of the runner", () => {
    const step = stepNamed(build, "Rust toolchain and target");

    expect(step.env).toEqual({ TARGET: "${{ matrix.target }}" });
    expect(step.run).toBe(
      'rustup toolchain install\nrustup target add "$TARGET"\n',
    );
  });

  it("gives ring the clang of the runner as the C compiler of the musl targets, as the ring CI does", () => {
    const step = stepNamed(build, "clang for ring on musl");

    expect(step.if).toBe("runner.os == 'Linux'");
    expect(step.env).toEqual({ TARGET: "${{ matrix.target }}" });
    expect(step.run).toContain(
      "apt-get install --yes --no-install-recommends clang",
    );
    expect(step.run).toContain(
      'echo "CC_${TARGET//-/_}=clang" >> "$GITHUB_ENV"',
    );
  });

  it("links the C runtime statically on Windows, so the binary needs no Visual C++ runtime", () => {
    const step = stepNamed(build, "Static C runtime on Windows");

    expect(step.if).toBe("runner.os == 'Windows'");
    expect(step.run).toBe(
      'echo "RUSTFLAGS=-C target-feature=+crt-static" >> "$GITHUB_ENV"\n',
    );
  });

  it("puts the LLVM of Visual Studio on the PATH for Windows ARM64, as the ring BUILDING.md asks, and fails loud without it", () => {
    const step = stepNamed(build, "LLVM of Visual Studio for ARM64");

    expect(step.if).toBe("matrix.target == 'aarch64-pc-windows-msvc'");
    expect(step.run).toContain("vswhere.exe");
    expect(step.run).toContain('>> "$GITHUB_PATH"');
    expect(step.run).toContain("::error::");
    expect(step.run).toContain("exit 1");
  });

  it("builds the release binary through the rust:build script and checks and packages it through release:binary", () => {
    const compile = stepNamed(build, "Build");
    const check = stepNamed(build, "Check and package");

    expect(compile.env).toEqual({ TARGET: "${{ matrix.target }}" });
    expect(compile.run).toBe(
      'npm run --silent rust:build -- --target "$TARGET"',
    );
    expect(packageScripts["rust:build"]).toMatch(/--release --locked$/u);
    expect(check.env).toEqual({ TARGET: "${{ matrix.target }}" });
    expect(check.run).toBe('npm run --silent release:binary -- "$TARGET" dist');
    expect(packageScripts["release:binary"]).toBe(
      "node scripts/release-binary.mjs",
    );
  });

  it("uploads the binary and its sha256 under the asset name, failing when nothing was built", () => {
    expect(stepUsing(build, "actions/upload-artifact").with).toEqual({
      name: "${{ matrix.asset }}",
      path: "dist/",
      "if-no-files-found": "error",
    });
  });

  it("builds from scratch, without any cache, since a release must not depend on what an earlier run left", () => {
    const uses = build.steps.map((step) => step.uses ?? "");

    expect(uses.filter((item) => /cache/u.test(item))).toEqual([]);
  });

  it("runs the steps in the order the build needs", () => {
    expect(
      build.steps.map((step) => step.name ?? step.uses.split("@")[0]),
    ).toEqual([
      "Harden the runner",
      "actions/checkout",
      "actions/setup-node",
      "Rust toolchain and target",
      "clang for ring on musl",
      "Static C runtime on Windows",
      "LLVM of Visual Studio for ARM64",
      "Build",
      "Check and package",
      "Attest",
      "Upload",
    ]);
  });
});

describeWorkflowSecurity(FILE);
describeTaskContract(FILE);
