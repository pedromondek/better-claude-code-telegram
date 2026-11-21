import { describe, expect, it } from "vitest";

import { REPOSITORY } from "../../../npm/shim/shim.constants.mjs";
import { issueForm } from "../support/issue-form.mjs";

describe("ISSUE_TEMPLATE/config.yml", () => {
  const config = issueForm("config.yml");

  it("offers no blank issue to who has no write access, so every issue comes from a form", () => {
    expect(config.blank_issues_enabled).toBe(false);
  });

  it("points a vulnerability to the private report of the repository, never a public issue", () => {
    expect(config.contact_links).toEqual([
      {
        name: "Report a security vulnerability",
        url: "https://github.com/pedromondek/better-claude-code-telegram/security/advisories/new",
        about: "Report it privately, never in a public issue.",
      },
    ]);
    expect(config.contact_links[0].url).toBe(
      `https://github.com/${REPOSITORY}/security/advisories/new`,
    );
  });
});
