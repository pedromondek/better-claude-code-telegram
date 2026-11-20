#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHookInput } from "./lib/hook-input.mjs";

const PROJECT_COMMANDS = new Set(["commit"]);
const BRANCH_REVIEW_COMMAND = "pre-pr";
const PR_HEAD_OPTIONS = new Set(["--head", "-H"]);
const PR_CREATE_ACTIONS = new Set(["create", "new"]);
const HELP_FLAGS = new Set(["--help", "-h"]);
const SHELL_WRAPPERS = new Set([
  "!",
  "if",
  "while",
  "until",
  "then",
  "do",
  "else",
  "elif",
  "time",
  "command",
  "exec",
  "nohup",
  "sudo",
  "xargs",
]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set([
  "-s",
  "--signal",
  "-k",
  "--kill-after",
]);
const SEGMENT_SEPARATOR = /&&|\|\||;|\||\n|(?<![<>])&(?!>)/;
const HEREDOC_START = /(?<!<)<<(?!<)(-?)\s*(["']?)([\w-]+)\2/g;
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);
const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-C", "--chdir"]);
const COMMIT_SCRIPTS = new Set(["commit", "fixup:fuse"]);

const COMMIT_INTENT = [
  /^(?:please\s+|go\s+ahead\s+and\s+)?(?:commit|push)\b/,
  /\b(?:and|then|please|can you|could you|go ahead and)\s+(?:commit|push)\b/,
  /\b(?:make|create|do)\s+(?:a\s+|the\s+)?(?:commits?|push)\b/,
  /\bcommit(?:a|ar|e|em|amos)\b/,
  /\b(?:faz|fazer|faca|de|da|dar)\s+(?:o\s+|um\s+|os\s+)?commits?\b/,
  /\b(?:faz|fazer|faca|de|da|dar)\s+(?:o\s+|um\s+)?push\b/,
  /\bempurr(?:a|ar|e)\b/,
  /\bsob(?:e|ir)\s+(?:as\s+|os\s+)?(?:mudancas|alteracoes|commits)\b/,
];
const PR_INTENT = [
  /\b(?:open|create|make)\s+(?:a\s+|the\s+)?(?:pr|pull request)\b/,
  /\b(?:cri|abr)(?:a|e|ar|ir|am)\s+(?:a\s+|o\s+|uma\s+|um\s+)?(?:nova\s+|novo\s+)?(?:prs?|pull\s+requests?)\b/,
];

const RESUME_HINT =
  "If the command was already in progress and a message from the dev (such as the approval of a draft) ended it, call the Skill again and resume from the step where it stopped.";

const DENY_REASONS = {
  commit: `Commit and push go through /commit: call the Skill \`commit\` instead of running the command directly. It builds the plan by topic, asks for approval and validates each commit before the push. ${RESUME_HINT}`,
  [BRANCH_REVIEW_COMMAND]:
    "A PR only opens after /pre-pr on the branch: call the Skill `pre-pr`, which reviews the whole branch and ends by opening the PR through /commit. It holds for the branch it ran on until the session ends, so the PR that /commit opens after it goes through.",
};

const CONTEXT_CHECK =
  "First analyze the context of the conversation: the word alone is not enough. When in doubt, ask the dev instead of calling the command.";

const REMINDERS = {
  commit: `The message may be a request to commit or push. If it is, call the Skill \`commit\` before any git commit, git push or npm run commit. ${CONTEXT_CHECK}`,
  [BRANCH_REVIEW_COMMAND]: `The message may be a request to open the PR. If it is, call the Skill \`pre-pr\`, which reviews the whole branch and ends by opening the PR through /commit, before any gh pr create. ${CONTEXT_CHECK}`,
};

function stateFile(sessionId) {
  return join(
    tmpdir(),
    "claude-require-command",
    String(sessionId).replaceAll(/[^\w-]/g, "_"),
  );
}

function readActive(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
  } catch {
    return [];
  }
}

function writeState(file, value) {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  } catch {
    return;
  }
}

function writeActive(sessionId, commands) {
  writeState(stateFile(sessionId), commands);
}

function reviewedBranchesFile(sessionId) {
  return `${stateFile(sessionId)}.${BRANCH_REVIEW_COMMAND}`;
}

function readReviewedBranches(sessionId) {
  try {
    return JSON.parse(readFileSync(reviewedBranchesFile(sessionId), "utf8"));
  } catch {
    return [];
  }
}

function currentBranch(cwd) {
  const env = { ...process.env };

  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  const result = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: cwd ?? process.cwd(), encoding: "utf8", env },
  );

  return result.status === 0 ? result.stdout.trim() : undefined;
}

function markBranchReviewed(sessionId, cwd) {
  const branch = currentBranch(cwd);

  if (branch === undefined) return;

  writeState(reviewedBranchesFile(sessionId), [
    ...new Set([...readReviewedBranches(sessionId), branch]),
  ]);
}

function withoutHeredocBodies(command) {
  const kept = [];
  const pending = [];

  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      const { delimiter, stripTabs } = pending[0];
      const body = stripTabs ? line.replace(/^\t+/, "") : line;

      if (body === delimiter) pending.shift();
      continue;
    }

    kept.push(line);
    for (const match of line.matchAll(HEREDOC_START)) {
      pending.push({ stripTabs: match[1] === "-", delimiter: match[3] });
    }
  }

  return kept.join("\n");
}

function withoutQuotedText(command) {
  let result = "";
  let quote = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote === null) {
      if (char === "\\") {
        result += command.slice(index, index + 2);
        index += 1;
      } else if (char === "'" || char === '"') {
        quote = char;
        result += '""';
      } else {
        result += char;
      }
    } else if (char === "\\" && quote === '"') {
      index += 1;
    } else if (char === quote) {
      quote = null;
    }
  }

  return result;
}

function shellSegments(command) {
  return withoutQuotedText(withoutHeredocBodies(command)).split(
    SEGMENT_SEPARATOR,
  );
}

function skipEnvPrefix(tokens) {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (/^\w+=/.test(token)) {
      index += 1;
    } else if (token === "env") {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith("-")) {
        index += ENV_OPTIONS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
      }
    } else {
      break;
    }
  }

  return tokens.slice(index);
}

function withoutWrappers(tokens) {
  let index = 0;

  while (index < tokens.length) {
    if (SHELL_WRAPPERS.has(tokens[index])) {
      index += 1;
    } else if (tokens[index] === "timeout") {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith("-")) {
        index += TIMEOUT_OPTIONS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
      }
      index += 1;
    } else {
      break;
    }
  }

  return tokens.slice(index);
}

function commandTokens(segment) {
  return segment
    .replaceAll(/[(){}]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
}

function isHelpOnly(args) {
  return args.length === 1 && HELP_FLAGS.has(args[0]);
}

function gitSubcommandIndex(args) {
  let index = 0;

  while (index < args.length && args[index].startsWith("-")) {
    index += GIT_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1;
  }

  return index;
}

function npmScript(args) {
  const run = args.findIndex((token) => !token.startsWith("-"));

  if (args[run] !== "run" && args[run] !== "run-script") return undefined;

  return args.slice(run + 1).find((token) => !token.startsWith("-"));
}

function prHead(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (PR_HEAD_OPTIONS.has(args[index])) return args[index + 1];
    if (args[index].startsWith("--head=")) {
      return args[index].slice("--head=".length);
    }
  }

  return undefined;
}

function ghRequirement(args) {
  const [resource, action, ...rest] = args;

  return resource === "pr" && PR_CREATE_ACTIONS.has(action) && !isHelpOnly(rest)
    ? { pullRequest: prHead(rest) }
    : undefined;
}

function requiredCommand(segment) {
  const [path, ...args] = withoutWrappers(
    skipEnvPrefix(withoutWrappers(commandTokens(segment))),
  );
  const program = path?.split("/").at(-1);

  if (program === "git") {
    const index = gitSubcommandIndex(args);
    const subcommand = args[index];

    if (subcommand !== "commit" && subcommand !== "push") return undefined;

    return isHelpOnly(args.slice(index + 1)) ? undefined : "commit";
  }
  if (program === "npm") {
    return COMMIT_SCRIPTS.has(npmScript(args)) ? "commit" : undefined;
  }
  if (program === "gh") return ghRequirement(args);

  return undefined;
}

function deny(command) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENY_REASONS[command],
    },
  };
}

function missingForPullRequest(sessionId, cwd, active, head) {
  const branch = head ?? currentBranch(cwd);

  if (
    branch === undefined ||
    !readReviewedBranches(sessionId).includes(branch)
  ) {
    return BRANCH_REVIEW_COMMAND;
  }

  return active.includes("commit") ? undefined : "commit";
}

function missingCommand(sessionId, cwd, active, needed) {
  if (needed === undefined) return undefined;
  if (typeof needed === "object") {
    return missingForPullRequest(sessionId, cwd, active, needed.pullRequest);
  }

  return active.includes(needed) ? undefined : needed;
}

function onBash(sessionId, cwd, command) {
  const active = readActive(sessionId);
  const missing = shellSegments(String(command ?? ""))
    .map((segment) =>
      missingCommand(sessionId, cwd, active, requiredCommand(segment)),
    )
    .find((needed) => needed !== undefined);

  return missing === undefined ? undefined : deny(missing);
}

function onSkill(sessionId, cwd, skill) {
  const name = String(skill ?? "")
    .split(":")
    .at(-1);

  if (PROJECT_COMMANDS.has(name)) {
    writeActive(sessionId, [...new Set([...readActive(sessionId), name])]);
  }
  if (name === BRANCH_REVIEW_COMMAND) markBranchReviewed(sessionId, cwd);

  return undefined;
}

function normalized(text) {
  return text
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function onPrompt(sessionId, cwd, prompt) {
  const text = String(prompt ?? "").trim();
  const typed = /^\/(commit|pre-pr)(?![\w-])/.exec(text)?.[1];

  writeActive(sessionId, PROJECT_COMMANDS.has(typed) ? [typed] : []);
  if (typed === BRANCH_REVIEW_COMMAND) markBranchReviewed(sessionId, cwd);

  if (text.startsWith("/")) return undefined;

  const plain = normalized(text);
  const reminders = [
    ...(COMMIT_INTENT.some((pattern) => pattern.test(plain))
      ? [REMINDERS.commit]
      : []),
    ...(PR_INTENT.some((pattern) => pattern.test(plain))
      ? [REMINDERS[BRANCH_REVIEW_COMMAND]]
      : []),
  ];

  return reminders.length === 0
    ? undefined
    : {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: reminders.join("\n"),
        },
      };
}

function respond(input) {
  const sessionId = input?.session_id ?? "no-session";
  const cwd = input?.cwd;

  if (input?.hook_event_name === "UserPromptSubmit") {
    return onPrompt(sessionId, cwd, input.prompt);
  }
  if (input?.hook_event_name !== "PreToolUse") return undefined;
  if (input.tool_name === "Skill") {
    return onSkill(sessionId, cwd, input.tool_input?.skill);
  }
  if (input.tool_name === "Bash") {
    return onBash(sessionId, cwd, input.tool_input?.command);
  }

  return undefined;
}

const output = respond(await readHookInput());

if (output !== undefined) {
  process.stdout.write(JSON.stringify(output));
}
