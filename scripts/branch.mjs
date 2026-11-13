import { execFileSync } from "node:child_process";

import {
  branchName,
  branchSlug,
  isAllowedBranch,
  issueKey,
  issueNumberFromBranch,
  issueNumberFromPrTitle,
} from "./issue-key.mjs";

const PR_USAGE = 'npm run branch -- pr "<pull request title>" <branch>';
const USAGE = [
  "Usage: npm run branch -- <issue number> [summary] [--epic]",
  '       npm run branch -- "<title of a new issue>"',
  `       ${PR_USAGE}`,
].join("\n");
const EPIC_FLAG = "--epic";
const ISSUE_ARGUMENT = /^#?(\d+)$/u;
const ISSUE_URL = /\/issues\/(\d+)\s*$/u;

function parseIssueNumber(issue) {
  const match = ISSUE_ARGUMENT.exec(issue);

  if (match === null) {
    throw new TypeError(`"${issue}" is not an issue number (42, #42 or 0042).`);
  }

  return Number(match[1]);
}

export function createBranch({ issue, summary, epic = false, gh }) {
  const number = parseIssueNumber(issue);
  const details = gh.viewIssue(number);

  if (details.state !== "OPEN") {
    throw new Error(`Issue #${number} is closed.`);
  }

  const openChildren = gh.openSubIssues(number);

  if (openChildren.length > 0 && !epic) {
    const children = openChildren.map((child) => `#${child}`).join(", ");

    throw new Error(
      [
        `Issue #${number} has open sub-issues (${children}). An epic gets a branch only when its pull request closes all of them: check the scope first.`,
        `  It closes all of them: npm run branch -- ${number} --epic`,
        `  Otherwise, branch from the sub-issue: npm run branch -- ${openChildren[0]}`,
      ].join("\n"),
    );
  }

  const name = branchName(number, summary ?? details.title);
  gh.develop(number, name);

  return name;
}

export function createIssueAndBranch({ title, gh }) {
  if (branchSlug(title) === "") {
    throw new TypeError(`Title without text for the branch name: ${title}`);
  }

  const number = gh.createIssue(title.trim());
  const name = branchName(number, title);
  gh.develop(number, name);

  return { number, name };
}

export function issueNumberFromUrl(url) {
  const match = ISSUE_URL.exec(url);

  if (match === null) {
    throw new Error(`gh did not return the URL of the new issue: ${url}`);
  }

  return Number(match[1]);
}

export function branchCheckMessage(name) {
  if (isAllowedBranch(name)) return null;

  const slug = branchSlug(name) || "short-title";

  return [
    `✗ Branch "${name}" is outside the pattern ${issueKey(42)}-short-title (issue key + title in kebab-case).`,
    "  Create it from the issue, which links the branch to it: npm run branch -- <issue number>",
    '  Without an issue, open one together with the branch: npm run branch -- "<title>"',
    `  To rename a local branch: git branch -m ${name} <issue number>-${slug}`,
  ].join("\n");
}

export function pullRequestCheckMessage(title, branch) {
  const branchMessage = branchCheckMessage(branch);

  if (branchMessage !== null) return branchMessage;

  const number = issueNumberFromBranch(branch);

  if (number === null || issueNumberFromPrTitle(title) === number) return null;

  return [
    `✗ Pull request title "${title}" does not start with the key of the issue of the branch ${branch}.`,
    `  Expected: ${issueKey(number)}: <title of the issue>`,
  ].join("\n");
}

export function run(argv, { gh, log }) {
  const [command, ...rest] = argv;

  if (command === "pr") {
    const [title, branch] = rest;

    if (title === undefined || branch === undefined) {
      log(`Usage: ${PR_USAGE}`);
      return 1;
    }

    const message = pullRequestCheckMessage(title, branch);

    if (message === null) return 0;

    log(message);
    return 1;
  }

  if (command === "check") {
    const message = branchCheckMessage(rest[0] ?? "");

    if (message === null) return 0;

    log(message);
    return 1;
  }

  if (command === undefined) {
    log(USAGE);
    return 1;
  }

  const words = rest.filter((word) => word !== EPIC_FLAG);

  try {
    if (!ISSUE_ARGUMENT.test(command)) {
      if (rest.includes(EPIC_FLAG)) {
        throw new Error(`${EPIC_FLAG} needs the number of an existing issue.`);
      }

      const { number, name } = createIssueAndBranch({
        title: [command, ...words].join(" "),
        gh,
      });
      log(
        `✓ Issue #${number} opened and branch ${name} created from main and linked to it.`,
      );
      return 0;
    }

    const name = createBranch({
      issue: command,
      summary: words.length > 0 ? words.join(" ") : undefined,
      epic: rest.includes(EPIC_FLAG),
      gh,
    });
    log(`✓ Branch ${name} created from main and linked to the issue.`);
    return 0;
  } catch (error) {
    log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const ghCli = {
  createIssue: (title) =>
    issueNumberFromUrl(
      execFileSync(
        "gh",
        [
          "issue",
          "create",
          "--title",
          title,
          "--body",
          "Opened by npm run branch for work that had no issue yet.",
          "--assignee",
          "@me",
        ],
        { encoding: "utf8" },
      ),
    ),
  viewIssue: (number) =>
    JSON.parse(
      execFileSync(
        "gh",
        ["issue", "view", String(number), "--json", "number,title,state"],
        { encoding: "utf8" },
      ),
    ),
  openSubIssues: (number) =>
    JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/{owner}/{repo}/issues/${number}/sub_issues?per_page=100`,
        ],
        { encoding: "utf8" },
      ),
    )
      .flat()
      .filter((child) => child.state === "open")
      .map((child) => child.number),
  develop: (number, name) => {
    execFileSync(
      "gh",
      [
        "issue",
        "develop",
        String(number),
        "--name",
        name,
        "--base",
        "main",
        "--checkout",
      ],
      { stdio: "inherit" },
    );
  },
};

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    gh: ghCli,
    log: (line) => console.log(line),
  });
}
