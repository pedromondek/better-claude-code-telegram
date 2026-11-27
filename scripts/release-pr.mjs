import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkOrder,
  ledgerVersions,
  releasedVersions,
} from "./release-order.mjs";
import {
  BLOCK_END,
  DRAFT_MARK,
  ENGLISH_BLOCK,
  PORTUGUESE_BLOCK,
  notesSkeleton,
} from "./release-notes-layout.mjs";
import { NPM_REGISTRY } from "./release.constants.mjs";
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
export { DRAFT_MARK };

const BASE_BRANCH = "main";
const NOTES_CHECK = "Release notes";
const MARKERS_PROBLEM = `the description needs the notes between one ${NOTES_START} and one ${NOTES_END}`;
const USAGE =
  "usage: npm run release:pr -- plan|prepare <alpha|beta|rc|stable|version> | check-version (branch in PR_BRANCH) | check-notes (description in PR_BODY)";
const RELEASE_BRANCH = /^release\/v(.+)$/u;
const APPROVAL_WAIT = "waits for your approval in Review deployments";
const APPROVAL_SKIP = "opens the pull request without approval";
const NPM_ABBREVIATED = "application/vnd.npm.install-v1+json";
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
  return [
    NOTES_START,
    notesSkeleton(draft, version),
    NOTES_END,
    "",
    `Version pull request of v${version}, opened by the prepare release workflow.`,
    "",
    `The text between the two notes markers above is the body of the GitHub Release. It starts as the layout of the notes, with the git-cliff draft in the English block, and the \`${NOTES_CHECK}\` check stays red until the public notes replace it: write them with \`/release-notes\`, or edit this description and delete the \`${DRAFT_MARK}\` line. On merge, the release workflow publishes v${version} with these notes and records them in \`${notesPath(version)}\`.`,
    "",
  ].join("\n");
}

function withoutSpace(text) {
  return text.replaceAll(/\s+/gu, "");
}

function withoutLayout(text) {
  return [ENGLISH_BLOCK, PORTUGUESE_BLOCK, BLOCK_END].reduce(
    (rest, marker) => rest.replaceAll(withoutSpace(marker), ""),
    withoutSpace(
      text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith(">"))
        .join("\n"),
    ),
  );
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

  if (withoutLayout(notes) === "") {
    return "the notes are empty: write them with /release-notes";
  }

  if (!notes.includes(PORTUGUESE_BLOCK)) {
    return `the notes have no ${PORTUGUESE_BLOCK} block: write them with /release-notes`;
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

function ensureFilesAgree(root) {
  if (checkVersions(root).length > 0) {
    throw new Error(
      "the version files disagree: npm run release:version -- check names them",
    );
  }
}

function orderedVersion(version, released) {
  const { versions, warnings } = released();
  const order = checkOrder(version, versions);

  if (order.problem !== null) {
    throw new Error(order.problem);
  }

  return {
    version,
    from: versions.at(-1) ?? null,
    bump: order.bump,
    approval: order.approval,
    warnings,
  };
}

export function planRelease({ target, root, bumped, released }) {
  ensureFilesAgree(root);

  return orderedVersion(targetVersion(root, target, bumped), released);
}

export function prepareRelease({
  target,
  root,
  head,
  bumped,
  notes,
  released,
  github,
}) {
  const { version, warnings } = planRelease({
    target,
    root,
    bumped,
    released,
  });
  const tag = `v${version}`;
  const branch = releaseBranch(version);

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

    return { version, branch, url, warnings };
  } catch (error) {
    github.deleteBranch(branch);
    throw error;
  }
}

export function checkReleaseBranch({ branch, root, released }) {
  const match = RELEASE_BRANCH.exec(branch ?? "");

  if (match === null) {
    throw new Error(`${branch} is not a version branch (release/v<version>)`);
  }

  const [, version] = match;

  ensureFilesAgree(root);

  const current = readVersions(root)[0].version;

  if (current !== version) {
    throw new Error(
      `the version files are on ${current}, not on ${version} of the branch ${branch}`,
    );
  }

  return orderedVersion(version, released);
}

function planSummary({ version, from, bump, approval, warnings }) {
  const next = approval ? APPROVAL_WAIT : APPROVAL_SKIP;

  return [
    `### Release v${version}`,
    "",
    "| From | To | Bump | Next |",
    "| --- | --- | --- | --- |",
    `| ${from === null ? "nothing released" : `v${from}`} | v${version} | ${bump} | ${next} |`,
    "",
    ...warnings.map((warning) => `> ⚠ ${warning}`),
    "",
  ].join("\n");
}

function attempt(action, err) {
  try {
    return action();
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }
}

export function run(
  args,
  { root, env, head, bumped, notes, released, github, out, err },
) {
  const [command, value, ...rest] = args;
  const warn = (warnings) => {
    for (const warning of warnings) {
      out(`⚠ ${warning}`);
    }
  };

  if (command === "plan" && value !== undefined && rest.length === 0) {
    return attempt(() => {
      const plan = planRelease({ target: value, root, bumped, released });
      const from = plan.from === null ? "nothing released" : `v${plan.from}`;

      warn(plan.warnings);
      out(
        `✓ v${plan.version} (${plan.bump}, from ${from}) ${plan.approval ? APPROVAL_WAIT : APPROVAL_SKIP}`,
      );

      if (env.GITHUB_OUTPUT !== undefined) {
        appendFileSync(
          env.GITHUB_OUTPUT,
          `version=${plan.version}\nbump=${plan.bump}\napproval=${String(plan.approval)}\n`,
        );
      }

      if (env.GITHUB_STEP_SUMMARY !== undefined) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, planSummary(plan));
      }

      return 0;
    }, err);
  }

  if (command === "prepare" && value !== undefined && rest.length === 0) {
    return attempt(() => {
      const { version, branch, url, warnings } = prepareRelease({
        target: value,
        root,
        head,
        bumped,
        notes,
        released,
        github,
      });

      warn(warnings);
      out(`✓ v${version} prepared in ${branch}: ${url}`);

      return 0;
    }, err);
  }

  if (command === "check-version" && value === undefined) {
    return attempt(() => {
      const { version, warnings } = checkReleaseBranch({
        branch: env.PR_BRANCH,
        root,
        released,
      });

      warn(warnings);
      out(`✓ v${version} is free and comes in order`);

      return 0;
    }, err);
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

const SOURCE_COMMANDS = new Set(["plan", "prepare", "check-version"]);

const TAG_PREFIX = "refs/tags/v";

export async function npmVersions(name, fetchUrl) {
  const response = await fetchUrl(`${NPM_REGISTRY}/${name}`, {
    headers: { accept: NPM_ABBREVIATED },
  });

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error(`npm answered ${response.status} for ${name}`);
  }

  return Object.keys((await response.json()).versions);
}

export async function collectReleased({ root, ghJson, fetch: fetchUrl }) {
  const pages = (path) => ghJson(["api", "--paginate", "--slurp", path]).flat();
  const tags = pages("repos/{owner}/{repo}/git/matching-refs/tags/v")
    .map(({ ref }) => ref)
    .filter((ref) => ref.startsWith(TAG_PREFIX))
    .map((ref) => ref.slice(TAG_PREFIX.length));
  const releases = pages("repos/{owner}/{repo}/releases?per_page=100")
    .filter((release) => !release.draft)
    .map((release) => release.tag_name.replace(/^v/u, ""));
  const { name } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  return releasedVersions({
    tags,
    releases,
    npm: await npmVersions(name, fetchUrl),
    ledger: ledgerVersions(root),
  });
}

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  const args = process.argv.slice(2);
  let sources = { versions: [], warnings: [] };
  let unreadable = false;

  if (SOURCE_COMMANDS.has(args[0])) {
    try {
      sources = await collectReleased({
        root,
        ghJson: (ghArgs) => JSON.parse(gh(ghArgs)),
        fetch,
      });
    } catch (error) {
      console.error(
        `✗ could not read the released versions: ${error instanceof Error ? error.message : String(error)}`,
      );
      unreadable = true;
    }
  }

  process.exitCode = unreadable
    ? 1
    : run(args, {
        root,
        env: process.env,
        released: () => sources,
        head: () =>
          execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
        bumped: () => gitCliffBump(root),
        notes: (tag) =>
          gitCliff(
            root,
            ["--unreleased", "--tag", tag],
            "draft the release notes",
          ),
        github: githubCli,
        out: (line) => console.log(line),
        err: (line) => console.error(line),
      });
}
