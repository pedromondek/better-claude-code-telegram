import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  STAGES,
  VERSION_FILES,
  checkVersions,
  gitCliff,
  gitCliffBump,
  nextVersion,
  parseVersion,
  readVersions,
  setVersion,
} from "./version.mjs";

export const NOTES_START = "<!-- notes -->";
export const NOTES_END = "<!-- /notes -->";
export const DRAFT_MARK = "<!-- draft -->";

const BASE_BRANCH = "main";
const NOTES_CHECK = "Release notes";
const MARKERS_PROBLEM = `the description needs the notes between one ${NOTES_START} and one ${NOTES_END}`;
const USAGE =
  "usage: npm run release:pr -- prepare <alpha|beta|rc|stable|version> | check-notes (description in PR_BODY)";
const CREATE_COMMIT =
  "mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }";

export function releaseBranch(version) {
  return `release/v${version}`;
}

export function notesPath(version) {
  const { major, minor, patch, stage, number } = parseVersion(version);
  const name = stage === null ? "stable" : `${stage}.${number}`;

  return `docs/releases/${major}.${minor}.${patch}/${name}.md`;
}

export function draftFromCliff(text) {
  return text
    .trim()
    .replace(/^## [^\n]*\n*/u, "")
    .trim();
}

export function pullRequestBody(version, draft) {
  const notes = [DRAFT_MARK, draft].filter((line) => line !== "").join("\n");

  return [
    NOTES_START,
    notes,
    NOTES_END,
    "",
    `Version pull request of v${version}, opened by the prepare release workflow.`,
    "",
    `The text between the two notes markers above is the body of the GitHub Release. It starts as the git-cliff draft, and the \`${NOTES_CHECK}\` check stays red until the public notes replace it: write them with \`/release-notes\`, or edit this description and delete the \`${DRAFT_MARK}\` line. On merge, the release workflow publishes v${version} with these notes and records them in \`${notesPath(version)}\`.`,
    "",
  ].join("\n");
}

function markedNotes(body) {
  const text = (body ?? "").replaceAll("\r\n", "\n");
  const start = text.indexOf(NOTES_START);
  const end = text.indexOf(NOTES_END);
  const once =
    text.indexOf(NOTES_START, start + 1) === -1 &&
    text.indexOf(NOTES_END, end + 1) === -1;

  if (start === -1 || end < start || !once) {
    return null;
  }

  return text.slice(start + NOTES_START.length, end).trim();
}

export function notesFrom(body) {
  const notes = markedNotes(body);

  if (notes === null) {
    throw new Error(MARKERS_PROBLEM);
  }

  return notes;
}

export function notesProblem(body) {
  const notes = markedNotes(body);

  if (notes === null) {
    return MARKERS_PROBLEM;
  }

  if (notes.includes(DRAFT_MARK)) {
    return `the notes are still the git-cliff draft: write them with /release-notes, or edit the description and delete the ${DRAFT_MARK} line`;
  }

  if (notes === "") {
    return "the notes are empty: write them with /release-notes";
  }

  return null;
}

function targetVersion(root, target, bumped) {
  if (/^\d/u.test(target)) {
    parseVersion(target);

    return target;
  }

  if (!STAGES.includes(target)) {
    throw new Error(`unknown stage: ${target} (use alpha, beta, rc or stable)`);
  }

  const current = readVersions(root)[0].version;
  const stable = parseVersion(current).stage === null;

  return nextVersion(current, target, stable ? bumped() : current);
}

export function prepareRelease({ target, root, head, bumped, notes, github }) {
  if (checkVersions(root).length > 0) {
    throw new Error(
      "the version files disagree: npm run release:version -- check names them",
    );
  }

  const version = targetVersion(root, target, bumped);
  const tag = `v${version}`;
  const branch = releaseBranch(version);

  if (github.refExists(`tags/${tag}`)) {
    throw new Error(`the tag ${tag} already exists`);
  }

  if (github.refExists(`heads/${branch}`)) {
    throw new Error(
      `the branch ${branch} already exists: the version pull request opens once, so write its notes with /release-notes, or close it and delete the branch to prepare it again`,
    );
  }

  const draft = draftFromCliff(notes(tag));

  setVersion(root, version);

  const sha = head();

  github.createBranch(branch, sha);

  try {
    github.commitFiles({
      branch,
      expectedHead: sha,
      headline: `📦 build(root): release v${version}`,
      body: `Sets v${version} in every version file, from the prepare release workflow.`,
      files: VERSION_FILES.map((path) => ({
        path,
        contents: readFileSync(join(root, path)).toString("base64"),
      })),
    });

    const url = github.openPullRequest({
      base: BASE_BRANCH,
      head: branch,
      title: `Release v${version}`,
      body: pullRequestBody(version, draft),
    });

    return { version, branch, url };
  } catch (error) {
    github.deleteBranch(branch);
    throw error;
  }
}

export function run(
  args,
  { root, env, head, bumped, notes, github, out, err },
) {
  const [command, value, ...rest] = args;

  if (command === "prepare" && value !== undefined && rest.length === 0) {
    try {
      const { version, branch, url } = prepareRelease({
        target: value,
        root,
        head,
        bumped,
        notes,
        github,
      });

      out(`✓ v${version} prepared in ${branch}: ${url}`);

      return 0;
    } catch (error) {
      err(`✗ ${error instanceof Error ? error.message : String(error)}`);

      return 1;
    }
  }

  if (command === "check-notes" && value === undefined) {
    const problem = notesProblem(env.PR_BODY);

    if (problem === null) {
      out("✓ the release notes are written");

      return 0;
    }

    err(`✗ ${problem}`);

    return 1;
  }

  err(USAGE);

  return 2;
}

function gh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

const githubCli = {
  refExists: (ref) =>
    JSON.parse(
      gh(["api", `repos/{owner}/{repo}/git/matching-refs/${ref}`]),
    ).some((item) => item.ref === `refs/${ref}`),
  createBranch: (name, sha) => {
    gh([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/git/refs",
      "-f",
      `ref=refs/heads/${name}`,
      "-f",
      `sha=${sha}`,
    ]);
  },
  deleteBranch: (name) => {
    gh([
      "api",
      "--method",
      "DELETE",
      `repos/{owner}/{repo}/git/refs/heads/${name}`,
    ]);
  },
  commitFiles: ({ branch, expectedHead, headline, body, files }) => {
    gh(
      ["api", "graphql", "--input", "-"],
      JSON.stringify({
        query: CREATE_COMMIT,
        variables: {
          input: {
            branch: {
              repositoryNameWithOwner: process.env.GH_REPO,
              branchName: branch,
            },
            expectedHeadOid: expectedHead,
            message: { headline, body },
            fileChanges: { additions: files },
          },
        },
      }),
    );
  },
  openPullRequest: ({ base, head, title, body }) =>
    gh(
      [
        "pr",
        "create",
        "--base",
        base,
        "--head",
        head,
        "--title",
        title,
        "--body-file",
        "-",
      ],
      body,
    ).trim(),
};

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");

  process.exitCode = run(process.argv.slice(2), {
    root,
    env: process.env,
    head: () =>
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    bumped: () => gitCliffBump(root),
    notes: (tag) =>
      gitCliff(root, ["--unreleased", "--tag", tag], "draft the release notes"),
    github: githubCli,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
