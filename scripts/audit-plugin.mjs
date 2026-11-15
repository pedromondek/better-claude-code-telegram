import { execFileSync, spawnSync } from "node:child_process";

const PLUGIN_DIR = "plugins/telegram";
const SEVERE = new Set(["high", "critical"]);
const SECURITY_LABEL = "security";
const SECURITY_LABEL_COLOR = "b60205";
const ISSUE_TITLE =
  "Dependencies of the telegram plugin with high or critical advisories";
const ADVISORY_MARKER = /<!-- advisory: (\d+) -->/gu;
const AUDIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const USAGE = "usage: npm run audit:plugin [-- --issue]";

export function advisoriesOf(report) {
  return Object.entries(report)
    .flatMap(([name, advisories]) =>
      advisories
        .filter(({ severity }) => SEVERE.has(severity))
        .map(({ id, severity, title, url }) => ({
          name,
          id,
          severity,
          title,
          url,
        })),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

const marker = ({ id }) => `<!-- advisory: ${id} -->`;

const line = ({ name, severity, title, url }) =>
  `- ${name}, ${severity}: ${title} (${url})`;

function issueOf(advisories) {
  return {
    title: ISSUE_TITLE,
    label: SECURITY_LABEL,
    body: [
      `\`bun audit\` found these advisories in ${PLUGIN_DIR}/bun.lock:`,
      "",
      ...advisories.map(line),
      "",
      `Fixing it means resolving ${PLUGIN_DIR}/bun.lock again within the ranges of ${PLUGIN_DIR}/package.json, with the minimum release age of 7 days, until npm run audit:plugin passes.`,
      "",
      ...advisories.map(marker),
    ].join("\n"),
  };
}

function commentOf(advisories) {
  return [
    "`bun audit` found new advisories:",
    "",
    ...advisories.map(line),
    "",
    ...advisories.map(marker),
  ].join("\n");
}

function reportIssue({ env, github, out }, advisories) {
  const issue = github.openIssue();
  const listed = new Set(
    (issue?.texts ?? []).flatMap((text) =>
      [...text.matchAll(ADVISORY_MARKER)].map((match) => Number(match[1])),
    ),
  );
  const fresh = advisories.filter(({ id }) => !listed.has(id));

  if (issue !== null && fresh.length === 0) {
    out(`- every advisory is already in #${issue.number}`);
    return;
  }

  if (env.DRY_RUN === "1") {
    out(
      issue === null
        ? `Would open: ${ISSUE_TITLE}`
        : `Would comment on #${issue.number}:`,
    );
    out(issue === null ? issueOf(fresh).body : commentOf(fresh));
    return;
  }

  if (issue === null) {
    github.ensureLabel();
    out(`! opened #${github.createIssue(issueOf(fresh))}`);
    return;
  }

  github.comment(issue.number, commentOf(fresh));
  out(`! commented on #${issue.number}`);
}

export function run(args, { env, bun, github, out, err }) {
  const issueMode = args.length === 1 && args[0] === "--issue";

  if (args.length > 0 && !issueMode) {
    err(USAGE);
    return 2;
  }

  try {
    const advisories = advisoriesOf(bun.audit());

    if (advisories.length === 0) {
      out(
        "✓ no high or critical advisory in the dependencies of the telegram plugin",
      );
      return 0;
    }

    for (const { name, severity, title, url } of advisories) {
      err(`✗ ${name} ${severity}: ${title} - ${url}`);
    }

    if (issueMode) {
      reportIssue({ env, github, out }, advisories);
    }

    return 1;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const bun = {
  audit: () => {
    const result = spawnSync(
      "sh",
      ["scripts/mise-exec.sh", "bun", "audit", "--cwd", PLUGIN_DIR, "--json"],
      { encoding: "utf8", maxBuffer: AUDIT_OUTPUT_LIMIT },
    );

    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `bun audit did not answer with a report: ${(result.stderr ?? "").trim()}`,
      );
    }
  },
};

const github = {
  openIssue: () => {
    const [found] = JSON.parse(
      gh([
        "issue",
        "list",
        "--label",
        SECURITY_LABEL,
        "--state",
        "open",
        "--search",
        `"${ISSUE_TITLE}" in:title`,
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
      SECURITY_LABEL,
      "--color",
      SECURITY_LABEL_COLOR,
      "--description",
      "A known vulnerability to fix",
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
  process.exitCode = run(process.argv.slice(2), {
    env: process.env,
    bun,
    github,
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  });
}
