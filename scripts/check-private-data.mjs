import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";

const EMAIL = /[\w.%+-]+@[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}/giu;
const PUBLIC_EMAIL_DOMAIN =
  /(?:^|\.)(?:noreply\.github\.com|example\.(?:com|net|org)|example|test|invalid|localhost)$/iu;
const PUBLIC_EMAILS = new Set(["git@github.com"]);
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,\d+)? @@/u;
const DESTINATION = "+++ b/";

function escapeRegExp(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

export function machinePathPattern({ username, home }) {
  const user = escapeRegExp(username);
  const alternatives = [
    String.raw`/home/${user}(?![\w.-])`,
    String.raw`/Users/${user}(?![\w.-])`,
    String.raw`[a-z]:[\\/]+Users[\\/]+${user}(?![\w.-])`,
    String.raw`/mnt/[a-z]/Users/${user}(?![\w.-])`,
  ];

  if (home.split(/[\\/]/u).filter(Boolean).length >= 2) {
    alternatives.push(String.raw`${escapeRegExp(home)}(?![\w.-])`);
  }

  return new RegExp(alternatives.join("|"), "iu");
}

export function parseLocalPatterns(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.toLowerCase());
}

export function addedLines(diff) {
  const lines = [];
  let file;
  let inHeader = false;
  let next = 0;

  for (const line of diff.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);

    if (line.startsWith("diff --git ")) {
      inHeader = true;
      file = undefined;
    } else if (inHeader && line.startsWith(DESTINATION)) {
      file = line.slice(DESTINATION.length);
    } else if (hunk !== null) {
      inHeader = false;
      next = Number(hunk.groups.start);
    } else if (file !== undefined && line.startsWith("+")) {
      lines.push({ file, line: next, text: line.slice(1) });
      next += 1;
    }
  }

  return lines;
}

function isPublicEmail(email) {
  const lower = email.toLowerCase();

  return (
    PUBLIC_EMAILS.has(lower) ||
    PUBLIC_EMAIL_DOMAIN.test(lower.slice(lower.lastIndexOf("@") + 1))
  );
}

function hasLocalTerm(text, localPatterns) {
  const lower = text.toLowerCase();

  return localPatterns.some((pattern) => lower.includes(pattern));
}

function contentFindings(text, { machinePath, localPatterns }) {
  const kinds = [];

  if ([...text.matchAll(EMAIL)].some(([email]) => !isPublicEmail(email))) {
    kinds.push("personal e-mail");
  }

  if (machinePath.test(text)) kinds.push("path of this machine");

  if (hasLocalTerm(text, localPatterns)) {
    kinds.push("term from the local private list");
  }

  return kinds;
}

export function findPrivateData({
  diff,
  files,
  identities,
  localPatterns,
  username,
  home,
}) {
  const machinePath = machinePathPattern({ username, home });
  const findings = [];

  for (const file of files) {
    if (machinePath.test(file)) {
      findings.push({
        where: file,
        kind: "path of this machine in the file name",
      });
    }

    if (hasLocalTerm(file, localPatterns)) {
      findings.push({
        where: file,
        kind: "term from the local private list in the file name",
      });
    }
  }

  for (const { file, line, text } of addedLines(diff)) {
    for (const kind of contentFindings(text, { machinePath, localPatterns })) {
      findings.push({ where: `${file}:${line}`, kind });
    }
  }

  for (const [role, identity] of identities) {
    if (hasLocalTerm(identity, localPatterns)) {
      findings.push({
        where: `commit ${role}`,
        kind: "term from the local private list",
      });
    }
  }

  return findings;
}

export function formatFindings(findings, localListPath) {
  return [
    "",
    "✖ pre-commit: the stage has data that must not leave this machine:",
    ...findings.map(({ where, kind }) => `  - ${where}: ${kind}`),
    "  Remove it from the stage, or use a fictitious value: an example.com e-mail or a generic path.",
    `  Private terms of this clone (names, accounts, e-mails) go one per line in ${localListPath}, which git never versions.`,
  ].join("\n");
}

function git(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: Number.POSITIVE_INFINITY,
  });

  if (result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim());
  }

  return result.stdout;
}

function identityOf(variable) {
  return git(["var", variable]).replace(/ \d+ [+-]\d{4}\n?$/u, "");
}

if (import.meta.main) {
  const localListPath = git([
    "rev-parse",
    "--git-path",
    "info/private-data",
  ]).trim();
  const quotePathOff = ["-c", "core.quotePath=false"];
  const findings = findPrivateData({
    diff: git([
      ...quotePathOff,
      "diff",
      "--cached",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--unified=0",
      "--diff-filter=ACMR",
    ]),
    files: git([
      ...quotePathOff,
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACMR",
    ])
      .split("\n")
      .filter(Boolean),
    identities: [
      ["author", identityOf("GIT_AUTHOR_IDENT")],
      ["committer", identityOf("GIT_COMMITTER_IDENT")],
    ],
    localPatterns: existsSync(localListPath)
      ? parseLocalPatterns(readFileSync(localListPath, "utf8"))
      : [],
    username: userInfo().username,
    home: homedir(),
  });

  if (findings.length > 0) {
    console.error(formatFindings(findings, localListPath));
    process.exitCode = 1;
  }
}
