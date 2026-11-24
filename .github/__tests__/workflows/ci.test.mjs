import { describe, expect, it } from "vitest";

import { MERGED_PR_CHOICES } from "../../../scripts/merged-pr.mjs";
import { AuditOrigin } from "../../../scripts/workflow-audit-issue.mjs";
import {
  LOCAL_WORKFLOW,
  calledTask,
  describeWorkflowSecurity,
  stepUsing,
  triggers,
  workflow,
} from "../support/workflow.mjs";

const FILE = "ci.yml";
const ci = workflow(FILE);
const TASKS = {
  checks: "push-checks.yml",
  rust: "check-rust-platforms.yml",
  mutation: "check-mutation.yml",
  "pull-request": "check-pull-request.yml",
  "workflow-audit": "audit-workflows.yml",
  "workflow-audit-issue": "report-workflow-audit.yml",
};
const AGGREGATED = [
  "checks",
  "rust",
  "mutation",
  "pull-request",
  "workflow-audit",
];
const STAGES = {
  checks: "Checks",
  rust: "Rust on macOS and Windows",
  mutation: "Mutation",
  "workflow-audit": "Online audit of the workflows",
};
const PERMISSIONS = {
  checks: { contents: "read" },
  rust: { contents: "read" },
  mutation: { contents: "read" },
  "pull-request": { contents: "read", "pull-requests": "read" },
  "workflow-audit": { contents: "read", issues: "read" },
  "workflow-audit-issue": { contents: "read", issues: "write" },
};
const passed = ci.jobs["ci-passed"];

describe("ci.yml orchestrates the CI: it only calls the tasks and closes with one aggregate check", () => {
  it("has one job per task and the aggregate job only", () => {
    expect(Object.keys(ci.jobs).toSorted()).toEqual(
      [...Object.keys(TASKS), "ci-passed"].toSorted(),
    );
  });

  describe("triggers", () => {
    it("runs on pull_request, push and manual dispatch only", () => {
      expect(triggers(ci)).toEqual([
        "pull_request",
        "push",
        "workflow_dispatch",
      ]);
    });

    it("pushes only on main", () => {
      expect(ci.on.push).toEqual({ branches: ["main"] });
    });

    it("does not filter the pull requests by branch or path", () => {
      expect(ci.on.pull_request ?? null).toBeNull();
    });

    it("cancels the superseded run only for pull requests and gives every other run a group of its own", () => {
      expect(ci.concurrency.group).toBe(
        "${{ github.event_name == 'pull_request' && format('ci-{0}', github.ref) || format('ci-{0}', github.run_id) }}",
      );
      expect(ci.concurrency["cancel-in-progress"]).toBe(
        "${{ github.event_name == 'pull_request' }}",
      );
    });

    it("lets the manual dispatch pick every stage or a single task, with All as the default, and the merged pull request of the checks", () => {
      expect(ci.on.workflow_dispatch.inputs).toEqual({
        stage: {
          description: expect.any(String),
          required: true,
          type: "choice",
          default: "All",
          options: ["All", ...Object.values(STAGES)],
        },
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

    it("passes the merged pull request of the dispatch to the checks, empty on the other events", () => {
      expect(ci.jobs.checks.with).toEqual({
        pr: "${{ inputs.pr }}",
        pr_number: "${{ inputs.pr_number }}",
      });
    });

    it("passes to every task only the inputs it declares", () => {
      for (const id of Object.keys(TASKS)) {
        const declared = Object.keys(
          calledTask(ci.jobs[id]).on.workflow_call?.inputs ?? {},
        );

        expect({
          id,
          extra: Object.keys(ci.jobs[id].with ?? {}).filter(
            (name) => !declared.includes(name),
          ),
        }).toEqual({ id, extra: [] });
      }
    });
  });

  describe("task jobs", () => {
    it.each(Object.entries(TASKS))(
      "calls %s through $/ to %s, with no steps of its own",
      (id, file) => {
        expect(ci.jobs[id].uses).toBe(`${LOCAL_WORKFLOW}${file}`);
        expect(ci.jobs[id].steps).toBeUndefined();
      },
    );

    it.each(Object.entries(PERMISSIONS))(
      "grants %s exactly the permission its task asks for (%o)",
      (id, permissions) => {
        expect(ci.jobs[id].permissions).toEqual(permissions);
      },
    );

    it("audits the workflows online with the head and the base of the pull request, or the range of the push, and everything on a manual dispatch", () => {
      expect(ci.jobs["workflow-audit"].with).toEqual({
        ref: "${{ github.event.pull_request.head.sha }}",
        before:
          "${{ github.event.pull_request.base.sha || github.event.before }}",
        force: "${{ github.event_name == 'workflow_dispatch' }}",
      });
    });

    it("mutates the range of the pull request or of the push, from scratch only on a manual dispatch", () => {
      expect(ci.jobs.mutation.with).toEqual({
        before:
          "${{ github.event.pull_request.base.sha || github.event.before }}",
        full: "${{ github.event_name == 'workflow_dispatch' }}",
      });
    });

    it("opens or comments the issue of the online audit only when it failed on a push to main", () => {
      const issue = ci.jobs["workflow-audit-issue"];

      expect(issue.needs).toEqual(["workflow-audit"]);
      expect(issue.if).toBe(
        "always() && github.event_name == 'push' && needs.workflow-audit.result == 'failure'",
      );
      expect(issue.with).toEqual({ origin: AuditOrigin.MERGE });
    });

    it.each(Object.entries(TASKS))(
      "points %s to a task that the caller can call",
      (id) => {
        expect(calledTask(ci.jobs[id]).on.workflow_call).not.toBeUndefined();
      },
    );

    it.each(Object.entries(STAGES))(
      "runs %s on every event and on the manual dispatch of All or of its own stage",
      (id, stage) => {
        const others = Object.values(STAGES).filter((item) => item !== stage);

        expect(ci.jobs[id].if).toBe(
          others.map((item) => `inputs.stage != '${item}'`).join(" && "),
        );
      },
    );

    it("checks the pull request only on pull requests, since the title and the dependency review read the event", () => {
      expect(ci.jobs["pull-request"].if).toBe(
        "github.event_name == 'pull_request'",
      );
    });
  });

  describe("ci-passed job", () => {
    it("waits for every task, even when one fails or is skipped", () => {
      expect(passed.needs.toSorted()).toEqual(AGGREGATED.toSorted());
      expect(passed.if).toBe("${{ always() }}");
    });

    it("runs on ubuntu with a timeout, reading the contents and the jobs of the run", () => {
      expect(passed["runs-on"]).toMatch(/^ubuntu-/);
      expect(passed.permissions).toEqual({ contents: "read", actions: "read" });
      expect(passed["timeout-minutes"]).toBeGreaterThan(0);
    });

    it("hardens the runner, then checks out and sets up Node from the .nvmrc for the script", () => {
      expect(passed.steps[0].uses).toMatch(/^step-security\/harden-runner@/);
      expect(stepUsing(passed, "actions/checkout").with).toEqual({
        "persist-credentials": false,
      });
      expect(
        stepUsing(passed, "actions/setup-node").with["node-version-file"],
      ).toBe(".nvmrc");
    });

    it("fails first when a task failed or was cancelled, and passes when every task passed or was skipped", () => {
      const verdict = passed.steps[1];

      expect(verdict.name).toBe("A task failed or was cancelled");
      expect(verdict.if).toBe(
        "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')",
      );
      expect(verdict.run).toBe("exit 1");
    });

    it("ends by failing on any finished job of the run that failed, was cancelled or timed out, even inside a task its caller reported as passing", () => {
      const jobs = passed.steps.at(-1);

      expect(jobs.name).toBe("Every finished job of the run passed");
      expect(jobs.env).toEqual({
        GH_TOKEN: "${{ github.token }}",
        GH_REPO: "${{ github.repository }}",
        RUN_ID: "${{ github.run_id }}",
      });
      expect(jobs.run).toBe("npm run --silent ci:passed");
    });
  });
});

describeWorkflowSecurity(FILE);
