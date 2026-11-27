import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { TARGETS } from "./release-binary.mjs";
import { appendChecksums } from "./release-checksums.mjs";
import { CHECKSUMS_FILE } from "./release-order.mjs";
import {
  checkReleaseBranch,
  collectReleased,
  notesFrom,
  notesPath,
  notesProblem,
} from "./release-pr.mjs";
import { STABLE_BRANCH } from "./release.constants.mjs";
import { parseVersion } from "./version.mjs";

export const RELEASE_ASSETS = [
  ...TARGETS.flatMap(({ asset }) => [asset, `${asset}.sha256`]),
  "checksums.txt",
];

const BASE_BRANCH = "main";
const RELEASE_BRANCH = /^release\/v(.+)$/u;
const NOTES_FILE = "release-notes.md";
const USAGE =
  "usage: npm run release:publish -- plan | record <assets folder> | release <assets folder> | stable";
const CREATE_COMMIT =
  "mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }";

export function recordHeadline(version) {
  return `📦 build(root): record the checksums and notes of v${version}`;
}

export const short = (sha) => sha.slice(0, 7);

export function mergedReleaseRef(pr) {
  if (pr.state !== "MERGED" || !pr.mergeCommit) {
    throw new Error(`#${pr.number} was not merged`);
  }

  if (pr.baseRefName !== BASE_BRANCH) {
    throw new Error(
      `#${pr.number} was merged into ${pr.baseRefName}, not into ${BASE_BRANCH}`,
    );
  }

  const match = RELEASE_BRANCH.exec(pr.headRefName);

  if (match === null) {
    throw new Error(
      `#${pr.number} comes from ${pr.headRefName}, not from a release/v<version> branch`,
    );
  }

  return { version: match[1], merge: pr.mergeCommit.oid };
}

export function mergedRelease(pr) {
  const ref = mergedReleaseRef(pr);
  const problem = notesProblem(pr.body);

  if (problem !== null) {
    throw new Error(problem);
  }

  return { ...ref, notes: notesFrom(pr.body) };
}

function refusePublished(github, version) {
  const found = github.releaseByTag(`v${version}`);

  if (found !== null && !found.draft) {
    throw new Error(`v${version} is already published`);
  }

  return found;
}

function recordedCommit(github, { number, version, merge }) {
  const head = github.branchHead(BASE_BRANCH);

  if (head === merge) {
    return "";
  }

  const commit = github.commit(head);

  if (
    commit.parents.length === 1 &&
    commit.parents[0] === merge &&
    commit.headline === recordHeadline(version)
  ) {
    return head;
  }

  throw new Error(
    `main moved past the merge ${short(merge)} of #${number} to ${short(head)}, which is not the record of v${version}: publish it by hand, or release a new version`,
  );
}

export function output(env, values) {
  if (env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
}

function planLatest({ env, github, out }) {
  const number = Number(env.PR_NUMBER);
  const { version, merge } = mergedReleaseRef(github.pullRequest(number));
  const found = github.releaseByTag(`v${version}`);

  if (found === null || found.draft) {
    throw new Error(
      `v${version} is not published yet: run the release without only latest`,
    );
  }

  const prerelease = parseVersion(version).stage !== null;

  output(env, { number, version, merge, prerelease });
  out(`✓ v${version} from #${number} is published: only latest moves`);
}

function plan({ root, env, github, released, out }) {
  if (env.ONLY_LATEST === "true") {
    planLatest({ env, github, out });
    return;
  }

  const number = Number(env.PR_NUMBER);
  const { version, merge } = mergedRelease(github.pullRequest(number));
  const draft = refusePublished(github, version);
  const recorded = recordedCommit(github, { number, version, merge });
  const sources = released();

  checkReleaseBranch({
    branch: `release/v${version}`,
    root,
    released: () =>
      draft === null && recorded === ""
        ? sources
        : {
            ...sources,
            versions: sources.versions.filter((item) => item !== version),
          },
  });

  const prerelease = parseVersion(version).stage !== null;

  output(env, { number, version, merge, prerelease });
  out(
    `✓ v${version} from #${number}, built at ${short(merge)}${recorded === "" ? "" : `, resuming after ${short(recorded)}`}`,
  );
}

function record({ root, env, github, assetsDir, out }) {
  const { MERGE: merge, VERSION: version } = env;
  const recorded = recordedCommit(github, {
    number: Number(env.PR_NUMBER),
    version,
    merge,
  });

  if (recorded !== "") {
    output(env, { commit: recorded });
    out(`✓ v${version} is already recorded in ${short(recorded)}`);
    return;
  }

  appendChecksums({ root, assetsDir });

  const { notes } = mergedRelease(github.pullRequest(Number(env.PR_NUMBER)));
  const notesFile = notesPath(version);

  mkdirSync(dirname(join(root, notesFile)), { recursive: true });
  writeFileSync(join(root, notesFile), `${notes}\n`);

  const commit = github.commitFiles({
    branch: BASE_BRANCH,
    expectedHead: merge,
    headline: recordHeadline(version),
    body: `Records the checksums of the 6 binaries of v${version}, built at ${merge}, and its release notes.`,
    files: [CHECKSUMS_FILE, notesFile].map((path) => ({
      path,
      contents: readFileSync(join(root, path)).toString("base64"),
    })),
  });

  output(env, { commit });
  out(`✓ v${version} recorded in ${short(commit)}`);
}

function recordedHashes(text, version) {
  return new Map(
    text
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter(([lineVersion]) => lineVersion === version)
      .map(([, asset, hash]) => [asset, hash]),
  );
}

function checkAssets({ assetsDir, version, commit, checksums }) {
  const recorded = recordedHashes(checksums, version);

  for (const { asset } of TARGETS) {
    const path = join(assetsDir, asset);

    if (!existsSync(path)) {
      throw new Error(`${asset} is missing from ${assetsDir}`);
    }

    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");

    if (recorded.get(asset) !== hash) {
      throw new Error(
        `${asset} does not match the checksum recorded in ${short(commit)}: these binaries come from another build, so re-run only the failed jobs of the run that recorded them, or release a new version`,
      );
    }
  }
}

function release({ env, github, assetsDir, out }) {
  const { COMMIT: commit, VERSION: version } = env;
  const tag = `v${version}`;
  const existing = refusePublished(github, version);
  const checksums = github.fileAt(commit, CHECKSUMS_FILE);

  checkAssets({ assetsDir, version, commit, checksums });

  const { notes } = mergedRelease(github.pullRequest(Number(env.PR_NUMBER)));
  const notesFile = join(assetsDir, NOTES_FILE);

  writeFileSync(join(assetsDir, "checksums.txt"), checksums);
  writeFileSync(notesFile, `${notes}\n`);

  const prerelease = env.PRERELEASE === "true";
  const files = RELEASE_ASSETS.map((asset) => join(assetsDir, asset));
  const draft = { tag, target: commit, title: tag, notesFile, prerelease };

  if (existing === null) {
    github.createDraft({ ...draft, files });
  } else {
    github.editDraft(draft);
    github.upload({ tag, files });
  }

  github.publish({ tag, latest: !prerelease });
  out(`✓ ${tag} published at ${short(commit)}`);
}

function stable({ env, github, out }) {
  const { COMMIT: commit, VERSION: version } = env;
  const target = `${short(commit)}, the record of v${version}`;

  if (parseVersion(version).stage !== null) {
    throw new Error(`v${version} is a pre-release, which never moves stable`);
  }

  const head = github.branchHeadIfAny(STABLE_BRANCH);

  if (head === null) {
    github.createBranch(STABLE_BRANCH, commit);
    out(`✓ ${STABLE_BRANCH} created at ${target}`);
    return;
  }

  if (head === commit) {
    out(`✓ ${STABLE_BRANCH} is already at ${target}`);
    return;
  }

  const status = github.compare(head, commit);

  if (status !== "ahead") {
    throw new Error(
      `${STABLE_BRANCH} at ${short(head)} is not behind ${target} (the compare says ${status}): ${STABLE_BRANCH} only moves forward, so find what moved it`,
    );
  }

  github.moveBranch(STABLE_BRANCH, commit);
  out(`✓ ${STABLE_BRANCH} moved from ${short(head)} to ${target}`);
}

export function run(args, { root, env, github, released, out, err }) {
  const [command, folder, ...rest] = args;
  const withFolder = folder !== undefined && rest.length === 0;
  const commands = {
    plan: folder === undefined ? plan : null,
    record: withFolder ? record : null,
    release: withFolder ? release : null,
    stable: folder === undefined ? stable : null,
  };
  const action = Object.hasOwn(commands, command) ? commands[command] : null;

  if (action === null) {
    err(USAGE);
    return 2;
  }

  try {
    action({
      root,
      env,
      github,
      released,
      out,
      assetsDir: folder === undefined ? "" : resolve(root, folder),
    });
    return 0;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function gh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  });
}

export const githubCli = {
  pullRequest: (number) =>
    JSON.parse(
      gh([
        "pr",
        "view",
        String(number),
        "--json",
        "number,state,baseRefName,headRefName,body,mergeCommit",
      ]),
    ),
  branchHead: (branch) =>
    gh([
      "api",
      `repos/{owner}/{repo}/git/ref/heads/${branch}`,
      "--jq",
      ".object.sha",
    ]).trim(),
  commit: (sha) => {
    const commit = JSON.parse(
      gh(["api", `repos/{owner}/{repo}/commits/${sha}`]),
    );

    return {
      parents: commit.parents.map((parent) => parent.sha),
      headline: commit.commit.message.split("\n")[0],
    };
  },
  releaseByTag: (tag) => {
    const found = JSON.parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/{owner}/{repo}/releases?per_page=100",
      ]),
    )
      .flat()
      .find((item) => item.tag_name === tag);

    return found === undefined ? null : { draft: found.draft };
  },
  fileAt: (sha, path) =>
    gh([
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/{owner}/{repo}/contents/${path}?ref=${sha}`,
    ]),
  commitFiles: ({ branch, expectedHead, headline, body, files }) =>
    JSON.parse(
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
      ),
    ).data.createCommitOnBranch.commit.oid,
  createDraft: ({ tag, target, title, notesFile, prerelease, files }) => {
    gh([
      "release",
      "create",
      tag,
      "--draft",
      "--target",
      target,
      "--title",
      title,
      "--notes-file",
      notesFile,
      ...(prerelease ? ["--prerelease"] : []),
      ...files,
    ]);
  },
  editDraft: ({ tag, target, title, notesFile, prerelease }) => {
    gh([
      "release",
      "edit",
      tag,
      "--target",
      target,
      "--title",
      title,
      "--notes-file",
      notesFile,
      `--prerelease=${String(prerelease)}`,
    ]);
  },
  upload: ({ tag, files }) => {
    gh(["release", "upload", tag, ...files, "--clobber"]);
  },
  publish: ({ tag, latest }) => {
    gh(["release", "edit", tag, "--draft=false", `--latest=${String(latest)}`]);
  },
  branchHeadIfAny: (branch) => {
    const result = spawnSync(
      "gh",
      ["api", `repos/{owner}/{repo}/git/ref/heads/${branch}`],
      { encoding: "utf8" },
    );

    if (result.status === 0) {
      return JSON.parse(result.stdout).object.sha;
    }

    if (result.stdout.includes('"Not Found"')) {
      return null;
    }

    throw new Error(`gh api of ${branch} failed: ${result.stderr.trim()}`);
  },
  compare: (base, head) =>
    gh([
      "api",
      `repos/{owner}/{repo}/compare/${base}...${head}`,
      "--jq",
      ".status",
    ]).trim(),
  createBranch: (branch, sha) => {
    gh([
      "api",
      "-X",
      "POST",
      "repos/{owner}/{repo}/git/refs",
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${sha}`,
    ]);
  },
  moveBranch: (branch, sha) => {
    gh([
      "api",
      "-X",
      "PATCH",
      `repos/{owner}/{repo}/git/refs/heads/${branch}`,
      "-f",
      `sha=${sha}`,
      "-F",
      "force=false",
    ]);
  },
};

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  let sources = null;

  if (process.argv[2] === "plan") {
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
      process.exitCode = 1;
    }
  }

  if (process.exitCode !== 1) {
    process.exitCode = run(process.argv.slice(2), {
      root,
      env: process.env,
      github: githubCli,
      released: () => sources ?? { versions: [], warnings: [] },
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  }
}
