import { existsSync, globSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { read, ROOT } from "../support/workflow.mjs";

const config = parse(read(".coderabbit.yaml"));
const TONE_LIMIT = 250;
const RISK_LIMIT = 3000;
const UPSTREAM = "plugins/telegram/";
const PATCHED_UPSTREAM = [
  "plugins/telegram/server.ts",
  "plugins/telegram/skills/configure/SKILL.md",
];
const LOCAL_RULES = ".claude/rules/";
const LOCAL_RULE_REFERENCE = /\.claude\/rules\/|\b[a-z-]+\.md \d+\b/u;

const excluded = () =>
  config.reviews.path_filters
    .filter((filter) => filter.startsWith("!"))
    .map((filter) => filter.slice(1));

describe(".coderabbit.yaml", () => {
  it("reviews and chats in English, with the tone inside the limit CodeRabbit accepts", () => {
    expect(config.language).toBe("en-US");
    expect(config.tone_instructions.length).toBeLessThanOrEqual(TONE_LIMIT);
  });

  it("speaks in the chat only when mentioned and only to members, since anyone can comment on a public repository", () => {
    expect(config.chat).toEqual({
      auto_reply: false,
      allow_non_org_members: false,
      art: false,
    });
  });

  it("only comments: no automatic approval, no generated tests, and no legacy alias of the approval key", () => {
    expect(config.reviews.auto_approvals).toEqual({ enabled: false });
    expect(config.reviews).not.toHaveProperty("request_changes_workflow");
    expect(config.reviews.finishing_touches.unit_tests).toEqual({
      enabled: false,
    });
  });

  it("labels the pull requests it classifies as slop", () => {
    expect(config.reviews.slop_detection).toEqual({
      enabled: true,
      label: "slop",
    });
  });

  it("rates security and merge risk from what is sensitive in this project, inside the length CodeRabbit accepts", () => {
    const { security_risk_instructions, merge_risk_instructions } =
      config.reviews;

    expect(security_risk_instructions).toContain("token");
    expect(security_risk_instructions).toContain("checksums.txt");
    expect(merge_risk_instructions).toContain("hooks.json");
    expect(security_risk_instructions.length).toBeLessThanOrEqual(RISK_LIMIT);
    expect(merge_risk_instructions.length).toBeLessThanOrEqual(RISK_LIMIT);
  });

  it("enriches new issues and suggests labels without applying them", () => {
    expect(config.issue_enrichment).toEqual({
      auto_enrich: { enabled: true },
      planning: { enabled: true, auto_planning: { enabled: false } },
      labeling: { auto_apply_labels: false },
    });
  });

  it("gives the owner the longest window to reject a learning before it applies, kept to this repository", () => {
    expect(config.knowledge_base.learnings).toEqual({
      scope: "local",
      approval_delay: 30,
    });
  });

  it("reads the project guidelines from versioned files that exist, never from the local rules", () => {
    const files = config.knowledge_base.code_guidelines.filePatterns;

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({
        file,
        exists: existsSync(join(ROOT, file)),
        local: file.startsWith(LOCAL_RULES),
      }).toEqual({ file, exists: true, local: false });
    }
  });

  it("leaves out only paths that exist, so a renamed file does not slip back into the review", () => {
    for (const pattern of excluded()) {
      expect({
        pattern,
        matches: globSync(pattern, { cwd: ROOT }).length > 0,
      }).toEqual({ pattern, matches: true });
    }
  });

  it("keeps in the review the upstream files we patch and the extensions", () => {
    const upstreamFilters = excluded().filter((pattern) =>
      pattern.startsWith(UPSTREAM),
    );

    expect(upstreamFilters.length).toBeGreaterThan(0);
    for (const pattern of upstreamFilters) {
      expect(PATCHED_UPSTREAM).not.toContain(pattern);
      expect(pattern).not.toContain("extensions");
      expect(pattern).not.toContain("*");
    }
  });

  it("states each instruction by itself, without citing the local rules that neither CodeRabbit nor a reader of the repository can open", () => {
    const texts = [
      config.reviews.security_risk_instructions,
      config.reviews.merge_risk_instructions,
      ...config.reviews.path_instructions.map(
        ({ instructions }) => instructions,
      ),
    ];

    for (const text of texts) {
      expect(text).not.toMatch(LOCAL_RULE_REFERENCE);
    }
  });
});
