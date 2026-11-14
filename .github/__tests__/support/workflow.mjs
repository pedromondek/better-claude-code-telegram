import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parse } from "yaml";

export const ROOT = join(import.meta.dirname, "..", "..", "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
export const LOCAL_WORKFLOW = "$/.github/workflows/";
const PERMISSION_RANK = { none: 0, read: 1, write: 2 };

export const read = (path) => readFileSync(join(ROOT, path), "utf8");

export const workflow = (file) =>
  parse(readFileSync(join(WORKFLOWS_DIR, file), "utf8"));

export const allWorkflows = () =>
  Object.fromEntries(
    readdirSync(WORKFLOWS_DIR)
      .filter((file) => file.endsWith(".yml"))
      .map((file) => [file, workflow(file)]),
  );

export const triggers = (definition) => Object.keys(definition.on).toSorted();

export const stepById = (job, id) => job.steps.find((item) => item.id === id);

export const stepUsing = (job, uses) =>
  job.steps.find((item) => item.uses?.startsWith(`${uses}@`));

export const stepNamed = (job, name) =>
  job.steps.find((item) => item.name === name);

export const isLocal = (uses) => uses.startsWith("./") || uses.startsWith("$/");

export const calledTask = (job) =>
  workflow(job.uses.slice(LOCAL_WORKFLOW.length));

export const callerJobs = (definition) =>
  Object.entries(definition.jobs).filter(([, job]) =>
    job.uses?.startsWith(LOCAL_WORKFLOW),
  );

const PINNED_WITH_VERSION =
  /^\s*(?:-\s+)?uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

export const thirdPartyUsesLines = (path) =>
  read(path)
    .split("\n")
    .filter((line) => /^\s*(?:-\s+)?uses:\s/.test(line))
    .filter((line) => !/uses:\s+(?:\.|\$)\//.test(line));

export function assertPinnedWithVersion(path, { onlyCallsTasks = false } = {}) {
  const lines = thirdPartyUsesLines(path);

  expect(lines.length > 0).toBe(!onlyCallsTasks);
  for (const line of lines) {
    expect(line).toMatch(PINNED_WITH_VERSION);
  }
}

export const usesOf = (definition) =>
  Object.values(definition.jobs).flatMap((job) =>
    [job.uses, ...(job.steps ?? []).map((item) => item.uses)].filter(Boolean),
  );

export function describeWorkflowSecurity(file) {
  describe(`${file} security`, () => {
    const definition = workflow(file);

    it("starts the workflow with no permission, so each job asks for its own", () => {
      expect(definition.permissions).toEqual({});
    });

    it("names the workflow and every job, which shows in the Actions tab and in the checks", () => {
      for (const [id, item] of [
        ["workflow", definition],
        ...Object.entries(definition.jobs),
      ]) {
        expect({ id, type: typeof item.name }).toEqual({ id, type: "string" });
        expect({ id, name: item.name.trim() }).not.toEqual({ id, name: "" });
      }
    });

    it("runs every run step in bash with pipefail through the default shell", () => {
      expect(definition.defaults).toEqual({ run: { shell: "bash" } });
    });

    it("leaves every checkout without the credential persisted on the runner", () => {
      const checkouts = Object.values(definition.jobs).flatMap((job) =>
        (job.steps ?? []).filter((item) =>
          item.uses?.startsWith("actions/checkout@"),
        ),
      );

      for (const checkout of checkouts) {
        expect(checkout.with?.["persist-credentials"]).toBe(false);
      }
    });

    it("pins every third-party action by full SHA with the version comment on the same line", () => {
      assertPinnedWithVersion(`.github/workflows/${file}`, {
        onlyCallsTasks: Object.values(definition.jobs).every(
          (job) => job.steps === undefined,
        ),
      });
      for (const uses of usesOf(definition).filter((item) => !isLocal(item))) {
        expect(uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    });

    it("never interpolates an expression in a run step, passing event data through env", () => {
      for (const job of Object.values(definition.jobs)) {
        for (const item of job.steps ?? []) {
          expect(item.run ?? "").not.toMatch(/\$\{\{/);
        }
      }
    });

    it("passes to every called task only the secrets it declares, all the required ones, and never inherits them all", () => {
      for (const [callerName, caller] of callerJobs(definition)) {
        const declared = calledTask(caller).on.workflow_call?.secrets ?? {};
        const passed = Object.keys(caller.secrets ?? {});

        expect({ callerName, secrets: caller.secrets }).not.toEqual({
          callerName,
          secrets: "inherit",
        });
        expect(passed.filter((name) => !(name in declared))).toEqual([]);
        expect(
          Object.entries(declared)
            .filter(([name, spec]) => spec?.required && !passed.includes(name))
            .map(([name]) => name),
        ).toEqual([]);
      }
    });

    it("grants every called task at least the permission each of its jobs asks for", () => {
      for (const [callerName, caller] of callerJobs(definition)) {
        const granted = caller.permissions ?? definition.permissions;
        const called = calledTask(caller);

        for (const [calledName, calledJob] of Object.entries(called.jobs)) {
          const requested = calledJob.permissions ?? called.permissions;

          for (const [scope, level] of Object.entries(requested)) {
            const grantedLevel = granted[scope] ?? "none";

            expect({
              call: `${callerName} > ${calledName}`,
              scope,
              enough: PERMISSION_RANK[grantedLevel] >= PERMISSION_RANK[level],
            }).toEqual({
              call: `${callerName} > ${calledName}`,
              scope,
              enough: true,
            });
          }
        }
      }
    });
  });
}

export function describeTaskContract(file) {
  describe(`${file} as a task`, () => {
    const definition = workflow(file);

    it("can be called by the orchestrator through workflow_call", () => {
      expect(Object.keys(definition.on)).toContain("workflow_call");
    });

    it("declares no concurrency, which belongs to the caller, since github.workflow inside a task is the caller's", () => {
      expect(definition.concurrency).toBeUndefined();
    });

    it("checks out the code in every job, with the credential left off the runner", () => {
      for (const [id, job] of Object.entries(definition.jobs)) {
        const checkout = stepUsing(job, "actions/checkout");

        expect({
          id,
          persisted: checkout?.with?.["persist-credentials"],
        }).toEqual({
          id,
          persisted: false,
        });
      }
    });
  });
}
