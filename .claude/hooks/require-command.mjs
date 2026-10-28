#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_COMMANDS = new Set(["commit"]);
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
  /\b(?:open|create|make)\s+(?:a\s+|the\s+)?(?:pr|pull request)\b/,
  /\bcommit(?:a|ar|e|em|amos)\b/,
  /\b(?:faz|fazer|faca|de|da|dar)\s+(?:o\s+|um\s+|os\s+)?commits?\b/,
  /\b(?:faz|fazer|faca|de|da|dar)\s+(?:o\s+|um\s+)?push\b/,
  /\bempurr(?:a|ar|e)\b/,
  /\bsob(?:e|ir)\s+(?:as\s+|os\s+)?(?:mudancas|alteracoes|commits)\b/,
];

const RESUME_HINT =
  "If the command was already in progress and a message from the dev (such as the approval of a draft) ended it, call the Skill again and resume from the step where it stopped.";

const DENY_REASON = `Commit, push and PR go through /commit: call the Skill \`commit\` instead of running the command directly. It builds the plan by topic, asks for approval and validates each commit before the push. ${RESUME_HINT}`;

const REMINDER =
  "The message may be a request to commit or push. If it is, call the Skill `commit` before any git commit, git push, npm run commit or gh pr create. First analyze the context of the conversation: the word alone is not enough. When in doubt, ask the dev instead of calling the command.";

async function readHookInput() {
  const chunks = [];

  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

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

function writeActive(sessionId, commands) {
  try {
    const file = stateFile(sessionId);

    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(commands));
  } catch {
    return;
  }
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

function gitSubcommand(args) {
  let index = 0;

  while (index < args.length && args[index].startsWith("-")) {
    index += GIT_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1;
  }

  return args[index];
}

function npmScript(args) {
  if (args[0] !== "run" && args[0] !== "run-script") return undefined;

  return args.slice(1).find((token) => !token.startsWith("-"));
}

function ghRequiresCommit(args) {
  const [resource, action] = args;

  return resource === "pr" && action === "create";
}

function requiresCommit(segment) {
  const [program, ...args] = skipEnvPrefix(segment.trim().split(/\s+/));

  if (program === "git") {
    const subcommand = gitSubcommand(args);

    return subcommand === "commit" || subcommand === "push";
  }
  if (program === "npm") return COMMIT_SCRIPTS.has(npmScript(args));
  if (program === "gh") return ghRequiresCommit(args);

  return false;
}

function deny() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENY_REASON,
    },
  };
}

function onBash(sessionId, command) {
  const blocked = shellSegments(String(command ?? "")).some(requiresCommit);

  return blocked && !readActive(sessionId).includes("commit")
    ? deny()
    : undefined;
}

function onSkill(sessionId, skill) {
  const name = String(skill ?? "")
    .split(":")
    .at(-1);

  if (PROJECT_COMMANDS.has(name)) {
    writeActive(sessionId, [...new Set([...readActive(sessionId), name])]);
  }

  return undefined;
}

function normalized(text) {
  return text
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function onPrompt(sessionId, prompt) {
  const text = String(prompt ?? "").trim();
  const typed = /^\/(commit)\b/.exec(text)?.[1];

  writeActive(sessionId, typed === undefined ? [] : [typed]);

  if (text.startsWith("/")) return undefined;

  const plain = normalized(text);

  return COMMIT_INTENT.some((pattern) => pattern.test(plain))
    ? {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: REMINDER,
        },
      }
    : undefined;
}

function respond(input) {
  const sessionId = input?.session_id ?? "no-session";

  if (input?.hook_event_name === "UserPromptSubmit") {
    return onPrompt(sessionId, input.prompt);
  }
  if (input?.hook_event_name !== "PreToolUse") return undefined;
  if (input.tool_name === "Skill") {
    return onSkill(sessionId, input.tool_input?.skill);
  }
  if (input.tool_name === "Bash") {
    return onBash(sessionId, input.tool_input?.command);
  }

  return undefined;
}

const output = respond(await readHookInput());

if (output !== undefined) {
  process.stdout.write(JSON.stringify(output));
}
