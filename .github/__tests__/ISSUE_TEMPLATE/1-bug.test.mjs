import { describe, expect, it } from "vitest";

import { SETUP_COMMAND } from "../../../plugins/telegram-hooks/lib/package.constants.mjs";
import { describeIssueForm, issueForm } from "../support/issue-form.mjs";

const HEALTH = "npx @pedromondek/better-claude-code-telegram health";

describeIssueForm("1-bug.yml", {
  name: "Bug report",
  type: "Bug",
  labels: ["bug"],
  fields: [
    "what-happened",
    "steps-to-reproduce",
    "expected",
    "bcct-version",
    "claude-code-version",
    "os",
    "health",
    "regression",
    "frequency",
    "logs",
  ],
  required: [
    "what-happened",
    "steps-to-reproduce",
    "expected",
    "bcct-version",
    "claude-code-version",
    "os",
  ],
});

describe("1-bug.yml: what helps to reproduce", () => {
  const form = issueForm("1-bug.yml");
  const field = (id) => form.body.find((element) => element.id === id);

  it("asks to run the health check of the published command and paste its output", () => {
    expect(`${SETUP_COMMAND} health`).toBe(HEALTH);
    expect(form.body[0].attributes.value).toContain(`\`${HEALTH}\``);
  });

  it("asks for the versions of bcct and Claude Code and the system, where each command prints them", () => {
    expect(field("bcct-version").type).toBe("input");
    expect(field("bcct-version").attributes.description).toContain("`bcct -v`");
    expect(field("claude-code-version").type).toBe("input");
    expect(field("claude-code-version").attributes.description).toContain(
      "`claude --version`",
    );
    expect(field("os").type).toBe("dropdown");
    expect(field("os").attributes.options).toEqual([
      "Linux",
      "macOS",
      "Windows",
      "WSL",
    ]);
  });

  it("asks whether it is a regression and how often it happens, in lists", () => {
    expect(field("regression").attributes.options).toEqual([
      "Yes, it worked before",
      "No, it never worked",
      "I don't know",
    ]);
    expect(field("frequency").attributes.options).toEqual([
      "Always",
      "Sometimes",
      "Only once",
    ]);
  });

  it("takes the health output and the log as text in shell blocks", () => {
    expect(field("health").type).toBe("textarea");
    expect(field("health").attributes.render).toBe("shell");
    expect(field("logs").type).toBe("textarea");
    expect(field("logs").attributes.render).toBe("shell");
  });
});
