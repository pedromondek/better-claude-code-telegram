import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { labeledIssues } from "./labeled-issues.mjs";
import { AUDIT_LABEL, openAuditIssue } from "./workflow-audit.mjs";

export const AUDIT_LABEL_COLOR = "5319e7";
export const LOG_LIMIT = 60_000;

export const AuditOrigin = Object.freeze({
  MERGE: "Merge on main",
  WEEKLY: "Weekly run",
});

const TITLE = "Online audit of the workflows failed on main";
const LABEL_DESCRIPTION =
  "Finding of the online audit of the workflows (zizmor and pinact)";
const LOG_CUT = "… (output cut; see the run)";
const NO_LOG =
  "The audit failed before writing its output (install, runner or network); the error is in the run.";
const FINDING_LINE = /^ {2}│ (.+):(\d+) ([^/\s]+)\/(\S+): /u;
const FAILED_TOOL_LINE = /^ {2}(\S+) did not run:$/u;
const NEW_FINDINGS_HEADER = /^ {2}\d+ new findings? in this change:$/u;

export function auditOrigin({ origin, sha, repoUrl }) {
  if (origin === AuditOrigin.WEEKLY) {
    return { label: "the weekly run", url: "", ref: "main" };
  }

  return {
    label: `commit \`${sha.slice(0, 7)}\` of main`,
    url: `${repoUrl}/commit/${sha}`,
    ref: sha,
  };
}

export function parseAuditFindings(log) {
  const findings = [];
  const failedTools = [];
  let inNewFindings = false;

  for (const text of log.split("\n")) {
    const failed = FAILED_TOOL_LINE.exec(text);
    if (failed) {
      failedTools.push(failed[1]);
      inNewFindings = false;
      continue;
    }
    if (NEW_FINDINGS_HEADER.test(text)) {
      inNewFindings = true;
      continue;
    }
    const found = inNewFindings ? FINDING_LINE.exec(text) : null;
    if (found) {
      findings.push({
        file: found[1],
        line: found[2],
        tool: found[3],
        rule: found[4],
      });
    } else if (!text.startsWith("  │ ")) {
      inNewFindings = false;
    }
  }

  return { findings, failedTools };
}

function fence(text) {
  const longest = Math.max(
    0,
    ...(text.match(/`+/gu) ?? []).map((ticks) => ticks.length),
  );

  return "`".repeat(Math.max(3, longest + 1));
}

function logBlock(log) {
  if (!log.trim()) return [NO_LOG];

  const text =
    log.length > LOG_LIMIT
      ? `${log.slice(0, LOG_LIMIT)}\n${LOG_CUT}`
      : log.trimEnd();
  const marker = fence(text);

  return ["Audit output:", "", `${marker}text\n${text}\n${marker}`];
}

function whereLines({ origin, repoUrl, log }) {
  const { findings, failedTools } = parseAuditFindings(log);
  const lines = [
    ...findings.map(
      (found) =>
        `- [\`${found.file}:${found.line}\`](${repoUrl}/blob/${origin.ref}/${found.file}#L${found.line}) ${found.tool}/${found.rule}`,
    ),
    ...failedTools.map(
      (tool) => `- \`${tool}\` did not run: the tool stopped before auditing`,
    ),
  ];

  return lines.length > 0 ? ["Where:", "", ...lines, ""] : [];
}

function references({ origin, runUrl }) {
  return [...(origin.url ? [`Commit: ${origin.url}`] : []), `Run: ${runUrl}`];
}

export function auditIssueContent(context) {
  const body = [
    `The online audit of the workflows (zizmor and pinact, with the GitHub API) failed on ${context.origin.label}. The merge is not reverted: an online finding depends on data outside the repository, such as an impostor commit, an action with a security advisory or a tag that moved, and the fix goes forward in a new pull request from main.`,
    "",
    "While this issue is open, each new failure of the audit comments here.",
    "",
    ...whereLines(context),
    ...references(context),
    "",
    ...logBlock(context.log),
  ].join("\n");

  return { title: TITLE, body };
}

export function auditIssueComment(context) {
  return [
    `The online audit failed again on ${context.origin.label}.`,
    "",
    ...whereLines(context),
    ...references(context),
    "",
    ...logBlock(context.log),
  ].join("\n");
}

function ensureLabel(gh, warn) {
  try {
    labeledIssues(gh, {
      label: AUDIT_LABEL,
      color: AUDIT_LABEL_COLOR,
      description: LABEL_DESCRIPTION,
    }).ensureLabel();
    return [AUDIT_LABEL];
  } catch {
    warn(`Could not create the label ${AUDIT_LABEL}: going on without it.`);
    return [];
  }
}

function report(gh, warn, context) {
  const labels = ensureLabel(gh, warn);
  const existing = openAuditIssue(gh);

  if (existing) {
    gh(["issue", "comment", existing, "--body", auditIssueComment(context)]);
    return existing;
  }

  const { title, body } = auditIssueContent(context);

  return gh([
    "issue",
    "create",
    "--title",
    title,
    ...labels.flatMap((label) => ["--label", label]),
    "--body",
    body,
  ]);
}

export function run(env, { gh, readLog, log, warn }) {
  const repoUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`;
  const context = {
    origin: auditOrigin({
      origin: env.AUDIT_ORIGIN,
      sha: env.GITHUB_SHA,
      repoUrl,
    }),
    runUrl: `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}`,
    log: readLog(env.LOG_FILE),
    repoUrl,
  };

  if (env.DRY_RUN === "1") {
    const { title, body } = auditIssueContent(context);
    log(`[rehearsal] ${title}\n${body}`);
    return;
  }

  log(`Issue: ${report(gh, warn, context)}`);
}

function readOptional(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

if (import.meta.main) {
  run(process.env, {
    gh: (args) => execFileSync("gh", args, { encoding: "utf8" }).trim(),
    readLog: readOptional,
    log: console.log,
    warn: console.warn,
  });
}
