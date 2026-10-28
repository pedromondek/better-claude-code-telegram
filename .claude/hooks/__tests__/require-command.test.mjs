import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = join(import.meta.dirname, "..", "require-command.mjs");

let stateRoot;

function runHook(input, sessionId = "session-a") {
  const payload =
    typeof input === "string"
      ? input
      : JSON.stringify({ session_id: sessionId, ...input });

  return spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: stateRoot },
  });
}

function bash(command, sessionId) {
  return runHook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    },
    sessionId,
  );
}

function skill(name, sessionId) {
  return runHook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: { skill: name },
    },
    sessionId,
  );
}

function prompt(text, sessionId) {
  return runHook(
    { hook_event_name: "UserPromptSubmit", prompt: text },
    sessionId,
  );
}

function outputOf(result) {
  expect(result.status).toBe(0);
  expect(result.stdout).not.toBe("");

  return JSON.parse(result.stdout).hookSpecificOutput;
}

function verdictOf(result) {
  expect(result.status).toBe(0);

  if (result.stdout === "") return "silent";

  const output = JSON.parse(result.stdout).hookSpecificOutput;

  if (output.permissionDecision !== "deny") return "context";

  return output.permissionDecisionReason.includes("Skill `commit`") &&
    /\/commit\b/u.test(output.permissionDecisionReason)
    ? "deny"
    : "deny-without-commit-reason";
}

function bashInParallel(command, sessionId = "session-a") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, TMPDIR: stateRoot },
    });
    let stdout = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout }));
    child.stdin.end(
      JSON.stringify({
        session_id: sessionId,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
    );
  });
}

async function verdictsOf(commands, sessionId) {
  const results = await Promise.all(
    commands.map((command) => bashInParallel(command, sessionId)),
  );

  return results.map(verdictOf);
}

function all(verdict, commands) {
  return commands.map(() => verdict);
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "bcct-require-command-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("require-command: raw command outside the project command", () => {
  it("denies git commit, git push, npm run commit, npm run fixup:fuse and gh pr create with the reason", async () => {
    const commands = [
      "env -u GIT_DIR -u GIT_WORK_TREE git commit -F msg.txt",
      "git -C /repo push",
      "cd /repo && git push --force-with-lease",
      "git commit --fixup=abc123",
      "npm run commit",
      "npm run fixup:fuse",
      "npm run-script commit",
      "npm run --silent commit",
      'git commit -m "fix this; adjust the lint"',
      "git commit -F - <<'EOF'\nmessage body\nEOF",
      "git commit -m \"$(cat <<'EOF'\ntitle\n\nbody; with && inside\nEOF\n)\"",
      "git status & git push",
      "git push 2>&1 | tail -5",
      "GIT_AUTHOR_NAME=x git push",
      'gh pr create --base main --title "feat: x" --body-file -',
    ];

    expect(await verdictsOf(commands)).toEqual(all("deny", commands));
  });

  it("allows reads and checks that only mention commit or push", async () => {
    const commands = [
      "git status --short",
      "git log --oneline --grep commit",
      "npm run --silent check:commit -- abc123",
      "git commit-tree HEAD^{tree}",
      "gh issue list --search push",
      "echo git commit",
      "gh pr view --json number",
      'grep -n "x; git push" notes.md',
      "echo 'git status && git commit -m x'",
      "cat > test.sh <<'EOF'\ngit commit -m x\nnpm run commit\nEOF",
      "cat <<-DONE | node -\n\tgit push; npm run commit\n\tDONE",
      "git log --oneline 2>&1 | head -5",
      "npm run lint",
      "npm test",
    ];

    expect(await verdictsOf(commands)).toEqual(all("silent", commands));
  });

  it("does not manage branches or issues: branch creation and gh issue create pass", async () => {
    const commands = [
      "git checkout -b my-branch",
      "git switch -c my-branch",
      "git branch my-branch",
      "git worktree add ../dir",
      "npm run branch -- 42",
      'gh issue create --title "x" --body-file b.md',
      "gh issue develop 42 --name x",
    ];

    expect(await verdictsOf(commands)).toEqual(all("silent", commands));
  });

  it("answers nothing for a tool that is neither Bash nor Skill", () => {
    expect(
      verdictOf(
        runHook({
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/repo/x" },
        }),
      ),
    ).toBe("silent");
  });

  it("answers nothing for an event that is neither PreToolUse nor UserPromptSubmit", () => {
    expect(
      verdictOf(
        runHook({
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "git push" },
        }),
      ),
    ).toBe("silent");
  });

  it("answers nothing for input that is not JSON", () => {
    expect(verdictOf(runHook("not json"))).toBe("silent");
  });

  it("answers nothing when a Bash call has no command", () => {
    expect(
      verdictOf(runHook({ hook_event_name: "PreToolUse", tool_name: "Bash" })),
    ).toBe("silent");
  });

  it("still denies in the real settings wiring, where stderr is discarded and the exit code forced to 0", () => {
    const wired = spawnSync(
      "sh",
      ["-c", `node "${HOOK}" 2>/dev/null || true`],
      {
        input: JSON.stringify({
          session_id: "session-wired",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git push" },
        }),
        encoding: "utf8",
        env: { ...process.env, TMPDIR: stateRoot },
      },
    );

    expect(verdictOf(wired)).toBe("deny");
  });
});

describe("require-command: project command active in the turn", () => {
  it("the commit Skill allows commit, push and PR", async () => {
    expect(verdictOf(skill("commit"))).toBe("silent");

    const commands = [
      "env -u GIT_DIR git commit -F msg.txt",
      "git push",
      "npm run fixup:fuse",
      "gh pr create --base main --body-file -",
    ];

    expect(await verdictsOf(commands)).toEqual(all("silent", commands));
  });

  it("a plugin-prefixed commit Skill counts as the commit command", () => {
    skill("project:commit");

    expect(verdictOf(bash("git push"))).toBe("silent");
  });

  it("a Skill that is not the commit command allows nothing", () => {
    skill("review");

    expect(verdictOf(bash("git push"))).toBe("deny");
  });

  it("the command typed by the dev (/commit) allows like the Skill", () => {
    expect(verdictOf(prompt("/commit stage everything"))).toBe("silent");

    expect(verdictOf(bash("git commit -F msg.txt"))).toBe("silent");
  });

  it("a slash command that is not /commit allows nothing", () => {
    prompt("/commits are fun");

    expect(verdictOf(bash("git push"))).toBe("deny");
  });

  it("a new dev message ends the command of the previous turn", () => {
    skill("commit");

    expect(verdictOf(bash("git push"))).toBe("silent");

    prompt("now look at the lint");

    expect(verdictOf(bash("git push"))).toBe("deny");
  });

  it("an approval in prose in the middle of /commit ends the command, and the deny teaches to call the Skill again and resume", () => {
    skill("commit");
    prompt("go ahead");

    const output = outputOf(bash("git push"));

    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toMatch(
      /already in progress.*call the Skill again and resume from the step where it stopped/su,
    );

    skill("commit");

    expect(verdictOf(bash("git push"))).toBe("silent");
  });

  it("the state is per session", () => {
    skill("commit", "session-a");

    expect(verdictOf(bash("git push", "session-b"))).toBe("deny");
    expect(verdictOf(bash("git push", "session-a"))).toBe("silent");
  });

  it("an input without session id shares one fallback session", () => {
    runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: { skill: "commit" },
      session_id: undefined,
    });

    expect(
      verdictOf(
        runHook({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git push" },
          session_id: undefined,
        }),
      ),
    ).toBe("silent");
  });
});

describe("require-command: reminder from the dev message", () => {
  function reminderOf(text) {
    const output = outputOf(prompt(text));

    expect(output.hookEventName).toBe("UserPromptSubmit");
    expect(output.additionalContext).toContain("analyze the context");
    expect(output.additionalContext).toContain("When in doubt, ask the dev");

    return output.additionalContext;
  }

  it("a request to commit or push reminds to call /commit", () => {
    const texts = [
      "commit and push",
      "please commit the changes",
      "can you push this",
      "make a commit",
      "open a PR",
      "commita e dá push",
      "pode fazer o commit",
      "sobe as mudanças",
      "empurra pro remoto",
    ];

    expect(texts.map((text) => reminderOf(text))).toEqual(
      texts.map(() => expect.stringContaining("Skill `commit`")),
    );
  });

  it("a typed command and a message without a commit request remind nothing", () => {
    const texts = [
      "/commit autonomous",
      "how does the lint work?",
      "did yesterday's push fail?",
      "what is a commit hash?",
      "",
    ];

    expect(texts.map((text) => verdictOf(prompt(text)))).toEqual(
      all("silent", texts),
    );
  });
});

describe("require-command: state file", () => {
  function stateFiles() {
    const dir = join(stateRoot, "claude-require-command");

    return existsSync(dir)
      ? readdirSync(dir).map((name) => ({
          name,
          content: readFileSync(join(dir, name), "utf8"),
        }))
      : [];
  }

  it("stores only the command names, under a sanitized session id in the temp dir", () => {
    skill("commit", "../../etc/passwd session");

    expect(stateFiles()).toEqual([
      { name: "______etc_passwd_session", content: '["commit"]' },
    ]);
  });

  it("never stores the prompt, the command line or the cwd", () => {
    prompt("/commit my secret message", "session-x");
    skill("commit", "session-x");
    bash("git push --token=abc", "session-x");
    runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "hello",
        cwd: "/some/private/path",
        transcript_path: "/some/private/transcript.jsonl",
      },
      "session-x",
    );
    skill("commit", "session-x");

    const stored = stateFiles()
      .map((file) => file.content)
      .join("");

    expect(stored).toBe('["commit"]');
  });

  it("clears the state when the dev sends a message that is not /commit", () => {
    skill("commit", "session-x");
    prompt("hello", "session-x");

    expect(stateFiles()).toEqual([{ name: "session-x", content: "[]" }]);
  });

  it("does not fail when the state directory cannot be written", () => {
    const blocker = join(stateRoot, "blocker");

    writeFileSync(blocker, "");

    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        session_id: "session-a",
        hook_event_name: "UserPromptSubmit",
        prompt: "/commit",
      }),
      encoding: "utf8",
      env: { ...process.env, TMPDIR: blocker },
    });

    expect(result.status).toBe(0);
  });
});
