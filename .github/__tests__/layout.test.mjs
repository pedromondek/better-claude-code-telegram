import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { allWorkflows } from "./support/workflow.mjs";

const GITHUB = join(import.meta.dirname, "..");
const TESTS = import.meta.dirname;
const MAIN_ONLY = "github.ref == 'refs/heads/main'";
const PULL_REQUEST_SCOPED_CACHE = "rust-mutants-";
const READ_ONLY = { contents: "read" };
const READ_ISSUES = { contents: "read", issues: "read" };
const WRITE_ISSUES = { contents: "read", issues: "write" };
const ATTEST = {
  contents: "read",
  "id-token": "write",
  attestations: "write",
};
const READ_ATTESTATIONS = { contents: "read", attestations: "read" };
const EXTRA_PERMISSIONS = {
  "announce-release.yml > record": {
    contents: "read",
    "pull-requests": "read",
  },
  "audit-workflows-on-schedule.yml > audit": READ_ISSUES,
  "audit-workflows-on-schedule.yml > issue": WRITE_ISSUES,
  "audit-plugin-dependencies.yml > audit": WRITE_ISSUES,
  "audit-workflows.yml > audit": READ_ISSUES,
  "build-binaries.yml > build": ATTEST,
  "check-pull-request-notes.yml > patch-notes": {
    contents: "read",
    "pull-requests": "read",
  },
  "check-pull-request.yml > pull-request": {
    contents: "read",
    "pull-requests": "read",
  },
  "ci.yml > ci-passed": { contents: "read", actions: "read", checks: "read" },
  "ci.yml > pull-request": { contents: "read", "pull-requests": "read" },
  "ci.yml > workflow-audit": READ_ISSUES,
  "ci.yml > workflow-audit-issue": WRITE_ISSUES,
  "lock-pull-requests.yml > lock": {
    contents: "read",
    "pull-requests": "write",
    checks: "read",
  },
  "manage-ci-cache.yml > delete": { contents: "read", actions: "write" },
  "release.yml > announce": { contents: "read", "pull-requests": "read" },
  "release.yml > build": ATTEST,
  "release.yml > latest": { contents: "read", "id-token": "write" },
  "release.yml > npm": { contents: "read", "id-token": "write" },
  "release.yml > plan": { contents: "read", "pull-requests": "read" },
  "release.yml > verify": READ_ATTESTATIONS,
  "report-workflow-audit.yml > report": WRITE_ISSUES,
  "verify-release.yml > verify": READ_ATTESTATIONS,
  "watch-upstream.yml > watch": WRITE_ISSUES,
};

const namesIn = (dir, extension) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(extension))
        .map((file) => basename(file, extension))
        .toSorted()
    : [];

const allSteps = () =>
  Object.entries(allWorkflows()).flatMap(([file, definition]) =>
    Object.entries(definition.jobs).flatMap(([id, job]) =>
      (job.steps ?? []).map((step) => ({ file, id, job, step })),
    ),
  );

describe("each .github file has the test with the same name in the mirrored __tests__ folder", () => {
  it(".github/workflows/<name>.yml mirrors __tests__/workflows/<name>.test.mjs", () => {
    const sources = namesIn(join(GITHUB, "workflows"), ".yml");
    const tests = namesIn(join(TESTS, "workflows"), ".test.mjs");

    expect(sources.length).toBeGreaterThan(0);
    expect(tests).toEqual(sources);
  });

  it(".github/ISSUE_TEMPLATE/<name>.yml mirrors __tests__/ISSUE_TEMPLATE/<name>.test.mjs", () => {
    const sources = namesIn(join(GITHUB, "ISSUE_TEMPLATE"), ".yml");
    const tests = namesIn(join(TESTS, "ISSUE_TEMPLATE"), ".test.mjs");

    expect(sources).toEqual([
      "1-bug",
      "1-bug.pt-br",
      "2-feature",
      "2-feature.pt-br",
      "3-task",
      "3-task.pt-br",
      "config",
    ]);
    expect(tests).toEqual(sources);
  });

  it(".github/<name>.yml, .github/<name>.yaml, .github/<name>.md and the root .coderabbit.yaml mirror __tests__/config/<name>.test.mjs", () => {
    const sources = [
      ...namesIn(GITHUB, ".yml"),
      ...namesIn(GITHUB, ".yaml"),
      ...namesIn(GITHUB, ".md"),
      ...(existsSync(join(GITHUB, "..", ".coderabbit.yaml"))
        ? ["coderabbit"]
        : []),
    ].toSorted();
    const tests = namesIn(join(TESTS, "config"), ".test.mjs");

    expect(sources).toEqual([
      "actionlint",
      "coderabbit",
      "dependabot",
      "jactionlint",
      "pinact",
      "pull_request_template",
      "zizmor",
    ]);
    expect(tests).toEqual(sources);
  });

  it("leaves no loose test at the root of __tests__ besides this one", () => {
    const loose = readdirSync(TESTS).filter(
      (file) =>
        extname(file) === ".mjs" && file !== basename(import.meta.filename),
    );

    expect(loose).toEqual([]);
  });
});

const jobsWithSteps = () =>
  Object.entries(allWorkflows()).flatMap(([file, definition]) =>
    Object.entries(definition.jobs)
      .filter(([, job]) => job.uses === undefined)
      .map(([id, job]) => ({ file, id, job })),
  );

const taskCalls = () =>
  Object.entries(allWorkflows()).flatMap(([file, definition]) =>
    Object.entries(definition.jobs)
      .filter(([, job]) => job.uses !== undefined)
      .map(([id, job]) => ({ name: `${file} > ${id}`, uses: job.uses })),
  );

describe("rules of every workflow", () => {
  it("calls a task in a job through $/, which resolves it in the repository and the commit of the caller, never through ./", () => {
    const calls = taskCalls();

    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.filter(({ uses }) => !uses.startsWith("$/.github/workflows/")),
    ).toEqual([]);
  });

  it("gives every job either steps or a task call, never both", () => {
    const both = Object.entries(allWorkflows()).flatMap(([file, definition]) =>
      Object.entries(definition.jobs)
        .filter(
          ([, job]) => (job.uses === undefined) === (job.steps === undefined),
        )
        .map(([id]) => `${file} > ${id}`),
    );

    expect(both).toEqual([]);
  });

  it("starts every job with steps with Harden-Runner in audit mode, which records the network the job uses", () => {
    const jobs = jobsWithSteps().map(({ file, id, job }) => ({
      name: `${file} > ${id}`,
      first: job.steps[0],
    }));

    expect(jobs.length).toBeGreaterThan(0);
    expect(
      jobs
        .filter(
          ({ first }) =>
            !(first?.uses ?? "").startsWith("step-security/harden-runner@") ||
            first.with?.["egress-policy"] !== "audit",
        )
        .map(({ name }) => name),
    ).toEqual([]);
  });

  it("sets a timeout on every job with steps, the jobs of a called task included", () => {
    const jobs = jobsWithSteps().map(({ file, id, job }) => ({
      name: `${file} > ${id}`,
      timeout: job["timeout-minutes"],
    }));

    expect(jobs.length).toBeGreaterThan(0);
    const missing = jobs
      .filter(({ timeout }) => !Number.isInteger(timeout) || timeout <= 0)
      .map(({ name }) => name);

    expect(missing).toEqual([]);
  });

  it("grants every job and every task call exactly contents: read, except the jobs listed here with the permission each needs", () => {
    const wrong = Object.entries(allWorkflows()).flatMap(([file, definition]) =>
      Object.entries(definition.jobs)
        .map(([id, job]) => ({
          name: `${file} > ${id}`,
          permissions: job.permissions,
        }))
        .filter(
          ({ name, permissions }) =>
            JSON.stringify(permissions) !==
            JSON.stringify(EXTRA_PERMISSIONS[name] ?? READ_ONLY),
        )
        .map(({ name }) => name),
    );

    expect(wrong).toEqual([]);
  });

  it("lists only jobs that exist, so a renamed job does not keep its permission", () => {
    const jobs = new Set(
      Object.entries(allWorkflows()).flatMap(([file, definition]) =>
        Object.keys(definition.jobs).map((id) => `${file} > ${id}`),
      ),
    );

    expect(
      Object.keys(EXTRA_PERMISSIONS).filter((name) => !jobs.has(name)),
    ).toEqual([]);
  });

  it("never uses the combined actions/cache step, which saves on every ref", () => {
    const combined = allSteps().filter(({ step }) =>
      (step.uses ?? "").startsWith("actions/cache@"),
    );

    expect(combined).toEqual([]);
  });

  it("saves the cache only on main: every cache save step is gated by the main ref", () => {
    const saves = allSteps().filter(
      ({ step }) =>
        (step.uses ?? "").startsWith("actions/cache/save@") &&
        !step.with.key.startsWith(PULL_REQUEST_SCOPED_CACHE),
    );

    expect(saves.length).toBeGreaterThan(0);
    expect(saves.filter(({ step }) => !step.if.includes(MAIN_ONLY))).toEqual(
      [],
    );
  });

  it("saves on a pull request only the caught mutants, keyed by the branch, which main never restores from", () => {
    const scoped = allSteps().filter(({ step }) =>
      (step.with?.key ?? "").startsWith(PULL_REQUEST_SCOPED_CACHE),
    );

    expect(scoped.map(({ step }) => step.with.key)).toEqual([
      "rust-mutants-${{ github.head_ref || github.ref_name }}-${{ github.sha }}",
      "rust-mutants-${{ github.head_ref || github.ref_name }}-${{ github.sha }}",
    ]);
    expect(
      scoped.map(({ step }) => step.with["restore-keys"]).filter(Boolean),
    ).toEqual([
      "rust-mutants-${{ github.head_ref || github.ref_name }}-\nrust-mutants-main-\n",
    ]);
  });

  it("makes every mise step save its cache only on main, since mise-action saves on every ref by default", () => {
    const mise = allSteps().filter(({ step }) =>
      (step.uses ?? "").startsWith("jdx/mise-action@"),
    );

    expect(mise.length).toBeGreaterThan(0);
    expect(
      mise.filter(
        ({ step }) => step.with?.cache_save !== `\${{ ${MAIN_ONLY} }}`,
      ),
    ).toEqual([]);
  });

  it("makes every rust-cache step save only on main or never, leaving the pull requests read-only", () => {
    const rustCaches = allSteps().filter(({ step }) =>
      (step.uses ?? "").startsWith("Swatinem/rust-cache@"),
    );

    expect(rustCaches.length).toBeGreaterThan(0);
    expect(
      rustCaches.filter(
        ({ step }) =>
          ![`\${{ ${MAIN_ONLY} }}`, false].includes(step.with?.["save-if"]),
      ),
    ).toEqual([]);
  });

  it("never lets the setup actions save a cache of their own on a pull request", () => {
    const cachingSetups = allSteps().filter(
      ({ step }) =>
        (step.uses ?? "").startsWith("actions/setup-node@") &&
        step.with?.cache !== undefined,
    );

    expect(cachingSetups).toEqual([]);
  });
});
