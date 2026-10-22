import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { inlineClosingReferences } from "../../scripts/issue-key.mjs";

export const COMMIT_HEADER_MAX_LENGTH = 100;

const HEADER_PATTERN =
  /^(?<type>[^(:]+?)(?:\((?<scope>[^()]*)\))?: (?<subject>.*)$/u;
const GIT_GENERATED_PATTERN =
  /^(?:Merge |Revert "|Reapply "|(?:fixup|squash|amend)! )/u;
const FORMAT_EXAMPLE = "🔧 chore(root): update the pre-push hook";
const SCISSORS_PATTERN = /^# -+ >8 -+$/u;

function messageText(message) {
  const lines = message.split("\n");
  const scissors = lines.findIndex((line) => SCISSORS_PATTERN.test(line));

  return (scissors === -1 ? lines : lines.slice(0, scissors))
    .filter((line) => !line.startsWith("#"))
    .join("\n");
}

function inlineClosingProblem(reference) {
  const number = /#(\d+)/u.exec(reference)[1];

  return `"${reference}" in the middle of the text closes issue #${number} when the commit reaches main: to close the issue, use the line "Closes #${number}" on its own; to only mention it, "Refs #${number}"`;
}

export function commitTypes(czConfig) {
  return czConfig.types.map(({ value, emoji }) =>
    emoji ? `${emoji} ${value}` : value,
  );
}

function headerOf(message) {
  return message
    .split("\n")
    .map((line) => line.trimEnd())
    .find((line) => line !== "" && !line.startsWith("#"));
}

function parseHeader(header) {
  const groups = HEADER_PATTERN.exec(header)?.groups;

  if (groups === undefined) return undefined;

  const validScope = groups.scope === undefined || /^\S+$/u.test(groups.scope);
  const validSubject = groups.subject === groups.subject.trimStart();

  return validScope && validSubject ? groups : undefined;
}

export function validateCommitMessage(message, czConfig) {
  const header = headerOf(message);

  if (header === undefined) return ["the message is empty"];
  if (GIT_GENERATED_PATTERN.test(header)) return [];

  const problems = [];
  const parsed = parseHeader(header);

  if (parsed === undefined) {
    problems.push(
      `the header "${header}" does not follow the format type(scope): subject`,
    );
  } else {
    const { type, scope } = parsed;
    const scopes = czConfig.scopes ?? [];

    if (!commitTypes(czConfig).includes(type)) {
      problems.push(`the type "${type}" is not in cz.config.mjs`);
    }

    if (
      scope !== undefined &&
      !czConfig.allowCustomScopes &&
      !scopes.includes(scope)
    ) {
      problems.push(`the scope "${scope}" is not in cz.config.mjs`);
    }
  }

  const length = [...header].length;

  if (length > COMMIT_HEADER_MAX_LENGTH) {
    problems.push(
      `the header has ${length} characters; the limit is ${COMMIT_HEADER_MAX_LENGTH}`,
    );
  }

  problems.push(
    ...inlineClosingReferences(messageText(message)).map(inlineClosingProblem),
  );

  return problems;
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..", "..");
  const { default: czConfig } = await import(
    pathToFileURL(join(root, "cz.config.mjs")).href
  );
  const problems = validateCommitMessage(
    readFileSync(process.argv[2], "utf8"),
    czConfig,
  );

  if (problems.length > 0) {
    console.error(
      [
        "",
        "✖ commit-msg: the commit message does not follow cz.config.mjs:",
        ...problems.map((text) => `  - ${text}`),
        `  Format: type(scope): subject, with a header of up to ${COMMIT_HEADER_MAX_LENGTH} characters. E.g.: ${FORMAT_EXAMPLE}`,
        `  Types: ${commitTypes(czConfig).join(", ")}`,
      ].join("\n"),
    );
    process.exitCode = 1;
  }
}
