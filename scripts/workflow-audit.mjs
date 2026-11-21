import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { touchesWorkflowLint } from "./lint-workflows.mjs";

export const AUDIT_STEP = "online audit of the workflows";
export const AUDIT_LABEL = "ci/online-audit";

const ZIZMOR_SCRIPT = "lint:workflows:zizmor:online";
const PINACT_SCRIPT = "lint:workflows:pinact:online";
const AUDITED_FILE =
  /^\.github\/(?:workflows\/[^/]+|actions\/[^/]+\/action)\.ya?ml$/u;

export function shouldAudit({ force, files }) {
  return force || files === null || files.some(touchesWorkflowLint);
}

const relativeTo = (root, path) =>
  relative(root, resolve(root, path)).replaceAll("\\", "/");

export function zizmorFindings(results, root) {
  return results.map((result) => {
    const location =
      result.locations.find((item) => item.symbolic.kind === "Primary") ??
      result.locations[0];
    const file = relativeTo(root, location.symbolic.key.Local.verbatim_path);
    const route = JSON.stringify(location.symbolic.route.route);

    return {
      tool: "zizmor",
      rule: result.ident,
      file,
      line: location.concrete.location.start_point.row + 1,
      message: result.desc,
      key: `zizmor:${result.ident}:${file}:${route}`,
    };
  });
}

export function pinactFindings(report, root, readText) {
  return report.runs.flatMap((reportRun) =>
    reportRun.results.map((result) => {
      const { artifactLocation, region } = result.locations[0].physicalLocation;
      const file = relativeTo(root, artifactLocation.uri);
      const text =
        readText(file).split("\n")[region.startLine - 1]?.trim() ?? "";

      return {
        tool: "pinact",
        rule: result.ruleId,
        file,
        line: region.startLine,
        message: result.message.text,
        key: `pinact:${result.ruleId}:${file}:${text}`,
      };
    }),
  );
}

export function classifyFindings(head, base) {
  if (base === null) return { added: head, inherited: [] };

  const known = new Map();
  for (const found of base) {
    known.set(found.key, (known.get(found.key) ?? 0) + 1);
  }

  const added = [];
  const inherited = [];
  for (const found of head) {
    const left = known.get(found.key) ?? 0;

    if (left > 0) {
      known.set(found.key, left - 1);
      inherited.push(found);
    } else {
      added.push(found);
    }
  }

  return { added, inherited };
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const findingLine = (found) =>
  `  │ ${found.file}:${found.line} ${found.tool}/${found.rule}: ${found.message}`;
const indented = (output) =>
  output
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => `  │ ${line}`);
const issueNote = (issueUrl) =>
  issueUrl
    ? `issue: ${issueUrl}`
    : "no open issue: the weekly run on main opens one";

export function auditLog({ added, inherited, failures, issueUrl = "" }) {
  if (failures.length === 0 && added.length === 0) {
    if (inherited.length === 0) return `✓ ${AUDIT_STEP} OK\n`;

    return (
      [
        `⚠ ${AUDIT_STEP}: ${count(inherited.length, "finding", "findings")} already on main, none new (${issueNote(issueUrl)})`,
        ...inherited.map(findingLine),
      ].join("\n") + "\n"
    );
  }

  return (
    [
      `✗ ${AUDIT_STEP} failed`,
      ...failures.flatMap((failure) => [
        `  ${failure.name} did not run:`,
        ...indented(failure.output),
      ]),
      ...(added.length > 0
        ? [
            `  ${count(added.length, "new finding", "new findings")} in this change:`,
            ...added.map(findingLine),
          ]
        : []),
      ...(inherited.length > 0
        ? [
            `  ${count(inherited.length, "finding", "findings")} already on main (${issueNote(issueUrl)}):`,
            ...inherited.map(findingLine),
          ]
        : []),
    ].join("\n") + "\n"
  );
}

const escapeData = (text) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text) =>
  escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

export function annotations({ added, inherited }) {
  const line = (level, found, suffix) =>
    `::${level} file=${escapeProperty(found.file)},line=${found.line},title=${escapeProperty(`${found.tool}/${found.rule}${suffix}`)}::${escapeData(found.message)}`;

  return [
    ...added.map((found) => line("error", found, "")),
    ...inherited.map((found) => line("warning", found, " (already on main)")),
  ];
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function changedFiles(before) {
  if (!before) return null;

  try {
    return git(["diff", "--name-only", `${before}...HEAD`])
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

function mergeBase(before) {
  if (!before) return null;

  try {
    return git(["merge-base", before, "HEAD"]);
  } catch {
    return null;
  }
}

function materialize(commit) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-audit-base-"));
  const files = git(["ls-tree", "-r", "--name-only", commit, "--", ".github"])
    .split("\n")
    .filter(Boolean);

  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(
      join(dir, file),
      execFileSync("git", ["show", `${commit}:${file}`]),
    );
  }

  return dir;
}

function auditedFiles(root) {
  const github = join(root, ".github");
  if (!existsSync(github)) return [];

  return readdirSync(github, { recursive: true })
    .map((file) => `.github/${String(file).replaceAll("\\", "/")}`)
    .filter((file) => AUDITED_FILE.test(file))
    .toSorted();
}

function runTool(name, args) {
  return new Promise((done) => {
    const child = spawn("npm", ["run", "--silent", name, "--", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      done({ stdout, stderr: error.message });
    });
    child.on("close", () => {
      done({ stdout, stderr });
    });
  });
}

function parsed(name, { stdout, stderr }, toFindings) {
  try {
    return { findings: toFindings(JSON.parse(stdout)) };
  } catch {
    return { failure: { name, output: `${stdout}\n${stderr}` } };
  }
}

async function auditTree(root) {
  const files = auditedFiles(root);
  if (files.length === 0) return { findings: [], failures: [] };

  const absolute = (file) => (root === process.cwd() ? file : join(root, file));
  const outcomes = [
    parsed(
      ZIZMOR_SCRIPT,
      await runTool(ZIZMOR_SCRIPT, [absolute(".github")]),
      (results) => zizmorFindings(results, root),
    ),
    parsed(
      PINACT_SCRIPT,
      await runTool(PINACT_SCRIPT, files.map(absolute)),
      (report) =>
        pinactFindings(report, root, (file) =>
          readFileSync(join(root, file), "utf8"),
        ),
    ),
  ];

  return {
    findings: outcomes.flatMap((outcome) => outcome.findings ?? []),
    failures: outcomes.flatMap((outcome) =>
      outcome.failure ? [outcome.failure] : [],
    ),
  };
}

async function auditBase(commit) {
  if (!commit) return null;

  const dir = materialize(commit);
  try {
    const { findings, failures } = await auditTree(dir);
    return failures.length > 0 ? null : findings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function openAuditIssue(gh) {
  return gh([
    "issue",
    "list",
    "--label",
    AUDIT_LABEL,
    "--state",
    "open",
    "--json",
    "url",
    "--jq",
    '.[0].url // ""',
  ]).trim();
}

function openIssue() {
  try {
    return openAuditIssue((args) =>
      execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return "";
  }
}

async function main() {
  const { BEFORE, FORCE, LOG_FILE, GITHUB_OUTPUT } = process.env;

  if (!shouldAudit({ force: FORCE === "true", files: changedFiles(BEFORE) })) {
    writeFileSync(LOG_FILE, "");
    appendFileSync(GITHUB_OUTPUT, "ran=false\nexit=0\n");
    console.log(
      "Nothing in the range changes a workflow, an action or the lint tools: online audit skipped.",
    );
    return;
  }

  const head = await auditTree(process.cwd());
  const base = await auditBase(mergeBase(BEFORE));
  const { added, inherited } = classifyFindings(head.findings, base);
  const issueUrl = inherited.length > 0 ? openIssue() : "";
  const log = auditLog({ added, inherited, failures: head.failures, issueUrl });
  const exit = head.failures.length > 0 || added.length > 0 ? 1 : 0;

  for (const line of annotations({ added, inherited })) console.log(line);
  console.log(log.trimEnd());
  writeFileSync(LOG_FILE, log);
  appendFileSync(GITHUB_OUTPUT, `ran=true\nexit=${exit}\n`);
  process.exitCode = exit;
}

if (import.meta.main) {
  await main();
}
