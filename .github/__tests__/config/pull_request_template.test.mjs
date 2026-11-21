import { describe, expect, it } from "vitest";

import {
  DRAFT_MARK,
  NOTES_END,
  NOTES_START,
  notesFrom,
  pullRequestBody,
} from "../../../scripts/release-pr.mjs";
import { read } from "../support/workflow.mjs";

const template = read(".github/pull_request_template.md");

describe("pull_request_template.md", () => {
  it("asks for the summary, the issue it closes and how it was verified, in English and in pt-br", () => {
    expect(template).toBe(
      [
        "## Summary / Resumo",
        "",
        "<!-- What changes for whoever uses or maintains the project. / O que muda para quem usa ou mantém o projeto. -->",
        "",
        "Closes #",
        "",
        "## How it was verified / Como foi verificado",
        "",
        "<!-- The tests and checks that ran, and what was tried by hand. / Os testes e as checagens que rodaram, e o que foi testado à mão. -->",
        "",
      ].join("\n"),
    );
  });

  it("carries none of the markers of the release notes, so it never adds or doubles the notes of a version pull request", () => {
    expect(template).not.toContain(NOTES_START);
    expect(template).not.toContain(NOTES_END);
    expect(template).not.toContain(DRAFT_MARK);
  });

  it("leaves the notes of a version pull request as they are, even when it ends up in the same description", () => {
    const body = pullRequestBody(
      "0.2.0",
      "### ✨ Features\n\n- faster buttons",
    );

    expect(notesFrom(`${body}\n\n${template}`)).toBe(notesFrom(body));
    expect(notesFrom(`${template}\n\n${body}`)).toBe(notesFrom(body));
  });
});
