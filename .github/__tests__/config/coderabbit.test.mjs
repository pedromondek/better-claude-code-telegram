import { existsSync, globSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { allWorkflows, read, ROOT } from "../support/workflow.mjs";

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

  it("fails the CodeRabbit check when the review errors, so the ruleset that requires it blocks the merge", () => {
    expect(config.reviews.commit_status).toBe(true);
    expect(config.reviews.fail_commit_status).toBe(true);
  });

  it("drops the docstrings keys that CodeRabbit retired and no longer reads", () => {
    expect(config.reviews.pre_merge_checks).not.toHaveProperty("docstrings");
    expect(config.reviews.finishing_touches).not.toHaveProperty("docstrings");
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

  it("keeps its summary in the walkthrough comment and never writes the pull request description, where the release notes live", () => {
    expect(config.reviews.high_level_summary_in_walkthrough).toBe(true);
    expect(config.reviews).not.toHaveProperty("high_level_summary_placeholder");
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

  it("names the workflows that read a secret in the security risk, never claiming the CI has none", () => {
    const withSecrets = Object.keys(allWorkflows()).filter((file) =>
      read(`.github/workflows/${file}`).includes("secrets."),
    );
    const { security_risk_instructions } = config.reviews;

    expect(withSecrets.toSorted()).toEqual([
      "announce-release.yml",
      "prepare-release.yml",
      "release.yml",
    ]);
    expect(security_risk_instructions).not.toMatch(/no secrets/u);
    for (const file of withSecrets) {
      expect(security_risk_instructions).toContain(file);
    }
  });

  it("tells the review of .github the caught Rust mutants are the one cache saved on a pull request", () => {
    const { instructions } = config.reviews.path_instructions.find(
      ({ path }) => path === ".github/**",
    );

    expect(read(".github/workflows/check-mutation.yml")).toContain(
      "key: rust-mutants-${{ github.head_ref || github.ref_name }}-",
    );
    expect(instructions).toMatch(
      /saved only on main, never on a pull request, except\s+the caught Rust mutants of check-mutation\.yml/u,
    );
  });
});
