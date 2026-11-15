import { execFileSync } from "node:child_process";

import {
  UPSTREAM_COMMIT,
  UPSTREAM_LABEL,
  UPSTREAM_LABEL_COLOR,
  UPSTREAM_PATH,
  UPSTREAM_REPOSITORY,
  UPSTREAM_VERSION,
} from "./upstream.constants.mjs";

const GH_OUTPUT_LIMIT = 16 * 1024 * 1024;
const HEAD_MARKER = /<!-- upstream-head: ([0-9a-f]{40}) -->/gu;
const ADOPT =
  "Adopting it means updating plugins/telegram, NOTICE and scripts/upstream.constants.mjs together.";

const short = (sha) => sha.slice(0, 7);

const marker = (head) => `<!-- upstream-head: ${head} -->`;

function lastReportedHead(texts) {
  const heads = texts.flatMap((text) =>
    [...text.matchAll(HEAD_MARKER)].map((match) => match[1]),
  );

  return heads.at(-1) ?? UPSTREAM_COMMIT;
}

export function changedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .toSorted();
}

function commitsSince(commits, base) {
  const end = commits.findIndex(({ sha }) => sha === base);

  return end === -1 ? commits : commits.slice(0, end);
}

function changeLines({ commits, files, from, to }) {
  return [
    `Commits since ${short(from)}:`,
    ...commits.map(({ sha, headline }) => `- ${short(sha)} ${headline}`),
    "",
    `Files changed: ${files.length > 0 ? files.join(", ") : "none under the folder"}`,
    "",
    `Compare: https://github.com/${UPSTREAM_REPOSITORY}/compare/${short(from)}...${short(to)}`,
  ];
}

function issueOf(change) {
  return {
    title: `The official Telegram plugin moved past ${UPSTREAM_VERSION} (${short(change.from)} → ${short(change.to)})`,
    label: UPSTREAM_LABEL,
    body: [
      `Version: ${UPSTREAM_VERSION} → ${change.version}`,
      "",
      ...changeLines(change),
      "",
      ADOPT,
      "",
      marker(change.to),
    ].join("\n"),
  };
}

function commentOf(change) {
  return [
    `The official plugin moved again, to ${change.version} (${short(change.from)} → ${short(change.to)}).`,
    "",
    ...changeLines(change),
    "",
    marker(change.to),
  ].join("\n");
}

function watch({ env, github, out }) {
  const { version, head } = github.upstreamPlugin();

  if (version === UPSTREAM_VERSION) {
    out(`✓ the official plugin is still at ${UPSTREAM_VERSION}`);
    return;
  }

  const issue = github.openIssue();
  const from = lastReportedHead(issue?.texts ?? []);

  if (from === head) {
    out(
      `- the official plugin at ${version} (${short(head)}) is already in #${issue.number}`,
    );
    return;
  }

  const change = {
    version,
    from,
    to: head,
    commits: commitsSince(github.upstreamCommits(), from),
    files: changedPaths(github.folderFiles(from), github.folderFiles(head)),
  };
  const moved = `! the official plugin moved to ${version} (${short(head)})`;

  if (env.DRY_RUN === "1") {
    const draft = issueOf(change);

    out(
      issue === null
        ? `Would open: ${draft.title}`
        : `Would comment on #${issue.number}:`,
    );
    out(issue === null ? draft.body : commentOf(change));
    return;
  }

  if (issue === null) {
    github.ensureLabel();
    out(`${moved}: opened #${github.createIssue(issueOf(change))}`);
    return;
  }

  github.comment(issue.number, commentOf(change));
  out(`${moved}: commented on #${issue.number}`);
}

export function run(env, { github, out, err }) {
  try {
    watch({ env, github, out });
    return 0;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: GH_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const upstreamApi = (path) => `repos/${UPSTREAM_REPOSITORY}/${path}`;

const github = {
  upstreamPlugin: () => ({
    version: JSON.parse(
      gh([
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        upstreamApi(`contents/${UPSTREAM_PATH}/.claude-plugin/plugin.json`),
      ]),
    ).version,
    head: gh([
      "api",
      upstreamApi(`commits?path=${UPSTREAM_PATH}&per_page=1`),
      "--jq",
      ".[0].sha",
    ]).trim(),
  }),
  upstreamCommits: () =>
    JSON.parse(
      gh([
        "api",
        upstreamApi(`commits?path=${UPSTREAM_PATH}&per_page=100`),
        "--jq",
        '[.[] | {sha, headline: (.commit.message | split("\\n")[0])}]',
      ]),
    ),
  folderFiles: (commit) =>
    new Map(
      gh([
        "api",
        upstreamApi(`git/trees/${commit}?recursive=1`),
        "--jq",
        `.tree[] | select(.type == "blob") | select(.path | startswith("${UPSTREAM_PATH}/")) | "\\(.path) \\(.sha)"`,
      ])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [path, sha] = line.split(" ");

          return [path.slice(UPSTREAM_PATH.length + 1), sha];
        }),
    ),
  openIssue: () => {
    const [found] = JSON.parse(
      gh([
        "issue",
        "list",
        "--label",
        UPSTREAM_LABEL,
        "--state",
        "open",
        "--json",
        "number,body,comments",
        "--limit",
        "1",
      ]),
    );

    return found === undefined
      ? null
      : {
          number: found.number,
          texts: [found.body, ...found.comments.map(({ body }) => body)],
        };
  },
  ensureLabel: () => {
    gh([
      "label",
      "create",
      UPSTREAM_LABEL,
      "--color",
      UPSTREAM_LABEL_COLOR,
      "--description",
      "A new version of the official Telegram plugin to adopt",
      "--force",
    ]);
  },
  createIssue: ({ title, label, body }) =>
    Number(
      /\/issues\/(\d+)/u.exec(
        gh([
          "issue",
          "create",
          "--title",
          title,
          "--label",
          label,
          "--body",
          body,
        ]),
      )[1],
    ),
  comment: (number, body) => {
    gh(["issue", "comment", String(number), "--body", body]);
  },
};

if (import.meta.main) {
  process.exitCode = run(process.env, {
    github,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
