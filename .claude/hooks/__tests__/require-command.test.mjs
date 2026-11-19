import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
const HOOK_TIMEOUT = 30_000;
const FIRST_BRANCH = "0042-export-csv";

let stateRoot;
let repo;

function git(args, cwd = repo) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });

  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 0,
    stderr: "",
  });
}

function runHook(input, sessionId = "session-a") {
  const payload =
    typeof input === "string"
      ? input
      : JSON.stringify({ session_id: sessionId, cwd: repo, ...input });

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

  const reason = output.permissionDecisionReason;

  if (reason.includes("Skill `pre-pr`") && /\/pre-pr\b/u.test(reason)) {
    return "deny-pre-pr";
  }

  return reason.includes("Skill `commit`") && /\/commit\b/u.test(reason)
    ? "deny"
    : "deny-without-known-reason";
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
        cwd: repo,
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
  repo = join(stateRoot, "repo");
  mkdirSync(repo);
  git(["init", "--quiet", `--initial-branch=${FIRST_BRANCH}`]);
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe(
  "require-command: raw command outside the project command",
  { timeout: HOOK_TIMEOUT },
  () => {
    it("denies git commit, git push, npm run commit and npm run fixup:fuse with the reason", async () => {
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
        verdictOf(
          runHook({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
        ),
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
  },
);

describe(
  "require-command: project command active in the turn",
  { timeout: HOOK_TIMEOUT },
  () => {
    it("the commit Skill allows commit and push", async () => {
      expect(verdictOf(skill("commit"))).toBe("silent");

      const commands = [
        "env -u GIT_DIR git commit -F msg.txt",
        "git push",
        "npm run fixup:fuse",
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
  },
);

describe(
  "require-command: PR only after /pre-pr on the branch",
  { timeout: HOOK_TIMEOUT },
  () => {
    const CREATE_PR = "gh pr create --base main --body-file -";

    it("denies gh pr create without /pre-pr, whatever the options, with the reason", async () => {
      const commands = [
        CREATE_PR,
        'gh pr create --base main --title "feat: x" --body-file -',
        "cd /repo && gh pr create --fill",
        "GH_TOKEN=x gh pr create --fill",
        "gh pr create --fill 2>&1 | tail -5",
      ];

      expect(await verdictsOf(commands)).toEqual(all("deny-pre-pr", commands));

      const output = outputOf(bash(CREATE_PR));

      expect(output.permissionDecisionReason).toMatch(
        /until the session ends/u,
      );
    });

    it("allows reading and listing PRs without /pre-pr", async () => {
      const commands = [
        "gh pr view --json number",
        "gh pr list --head 0042-export-csv",
        "gh pr checks 2",
        "gh pr diff 2",
        "echo gh pr create",
      ];

      expect(await verdictsOf(commands)).toEqual(all("silent", commands));
    });

    it("the commit Skill alone does not open the PR: /pre-pr is missing", () => {
      expect(verdictOf(skill("commit"))).toBe("silent");

      expect(verdictOf(bash(CREATE_PR))).toBe("deny-pre-pr");
    });

    it("/pre-pr followed by /commit opens the PR of the branch", () => {
      expect(verdictOf(skill("pre-pr"))).toBe("silent");
      expect(verdictOf(skill("commit"))).toBe("silent");

      expect(verdictOf(bash(CREATE_PR))).toBe("silent");
    });

    it("a plugin-prefixed pre-pr Skill counts as /pre-pr", () => {
      skill("project:pre-pr");
      skill("commit");

      expect(verdictOf(bash(CREATE_PR))).toBe("silent");
    });

    it("the /pre-pr typed by the dev counts like the Skill", () => {
      expect(verdictOf(prompt("/pre-pr with cr"))).toBe("silent");
      skill("commit");

      expect(verdictOf(bash(CREATE_PR))).toBe("silent");
    });

    it("/pre-pr does not open the PR without /commit, and does not allow commit or push", () => {
      skill("pre-pr");

      expect(verdictOf(bash(CREATE_PR))).toBe("deny");
      expect(verdictOf(bash("git push"))).toBe("deny");
      expect(verdictOf(bash("git commit -F msg.txt"))).toBe("deny");
    });

    it("/pre-pr of the branch outlives new dev messages, /commit does not", () => {
      skill("pre-pr");
      prompt("go ahead and open it");

      expect(verdictOf(bash(CREATE_PR))).toBe("deny");

      skill("commit");

      expect(verdictOf(bash(CREATE_PR))).toBe("silent");
    });

    it("/pre-pr counts only for the branch where it ran", () => {
      skill("pre-pr");
      git(["switch", "--quiet", "--create", "0043-other"]);
      skill("commit");

      expect(verdictOf(bash(CREATE_PR))).toBe("deny-pre-pr");
    });

    it("--head, -H and --head= name the branch of the PR instead of the current one", () => {
      skill("pre-pr");
      git(["switch", "--quiet", "--create", "0043-other"]);
      skill("commit");

      expect(verdictOf(bash(`${CREATE_PR} --head ${FIRST_BRANCH}`))).toBe(
        "silent",
      );
      expect(verdictOf(bash(`${CREATE_PR} -H ${FIRST_BRANCH}`))).toBe("silent");
      expect(verdictOf(bash(`${CREATE_PR} --head=${FIRST_BRANCH}`))).toBe(
        "silent",
      );
      expect(verdictOf(bash(`${CREATE_PR} --head 0044-third`))).toBe(
        "deny-pre-pr",
      );
    });

    it("/pre-pr is per session", () => {
      skill("pre-pr", "session-a");
      skill("commit", "session-b");

      expect(verdictOf(bash(CREATE_PR, "session-b"))).toBe("deny-pre-pr");
      expect(verdictOf(bash(CREATE_PR, "session-a"))).toBe("deny");
    });

    it("/pre-pr on two branches of the same session keeps both", () => {
      skill("pre-pr");
      git(["switch", "--quiet", "--create", "0043-other"]);
      skill("pre-pr");
      skill("commit");

      expect(verdictOf(bash(CREATE_PR))).toBe("silent");
      expect(verdictOf(bash(`${CREATE_PR} --head ${FIRST_BRANCH}`))).toBe(
        "silent",
      );
    });

    it("denies the PR when there is no branch to check: detached HEAD", () => {
      git([
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      git(["switch", "--quiet", "--detach"]);
      skill("pre-pr");
      skill("commit");

      expect(verdictOf(bash(CREATE_PR))).toBe("deny-pre-pr");
    });

    it("denies the PR when the folder is not a repository", () => {
      const outside = join(stateRoot, "outside");

      mkdirSync(outside);
      runHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Skill",
          tool_input: { skill: "pre-pr" },
          cwd: outside,
        },
        "session-a",
      );
      skill("commit");

      expect(
        verdictOf(
          runHook({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: CREATE_PR },
            cwd: outside,
          }),
        ),
      ).toBe("deny-pre-pr");
    });

    it("denies the PR when the folder of the call does not exist", () => {
      skill("commit");

      expect(
        verdictOf(
          runHook({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: CREATE_PR },
            cwd: join(stateRoot, "missing"),
          }),
        ),
      ).toBe("deny-pre-pr");
    });

    it("falls back to the folder of the hook process when the input has no cwd", () => {
      function withoutCwd(event) {
        return spawnSync(process.execPath, [HOOK], {
          input: JSON.stringify({ session_id: "session-a", ...event }),
          cwd: repo,
          encoding: "utf8",
          env: { ...process.env, TMPDIR: stateRoot },
        });
      }

      withoutCwd({
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "pre-pr" },
      });
      skill("commit");

      expect(
        verdictOf(
          withoutCwd({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: CREATE_PR },
          }),
        ),
      ).toBe("silent");
    });

    it("ignores the git variables of the environment when it reads the branch", () => {
      skill("pre-pr");
      skill("commit");

      const result = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          session_id: "session-a",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: CREATE_PR },
        }),
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: stateRoot,
          GIT_DIR: join(stateRoot, "elsewhere"),
          GIT_WORK_TREE: join(stateRoot, "elsewhere"),
        },
      });

      expect(verdictOf(result)).toBe("silent");
    });
  },
);

describe(
  "require-command: reminder from the dev message",
  { timeout: HOOK_TIMEOUT },
  () => {
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
        "commita e dá push",
        "pode fazer o commit",
        "sobe as mudanças",
        "empurra pro remoto",
      ];

      expect(texts.map((text) => reminderOf(text))).toEqual(
        texts.map(() => expect.stringContaining("Skill `commit`")),
      );
    });

    it("a request to open the PR reminds to call /pre-pr, which opens it through /commit", () => {
      const texts = [
        "open a PR",
        "please create the pull request",
        "make a pr for this branch",
        "abrir pr",
        "abre a pr",
        "cria o pull request dessa branch",
      ];
      const reminders = texts.map((text) => reminderOf(text));

      expect(reminders).toEqual(
        texts.map(() => expect.stringContaining("Skill `pre-pr`")),
      );
      expect(reminders).toEqual(
        texts.map(() => expect.not.stringContaining("Skill `commit`")),
      );
    });

    it("a typed command and a message without a commit or PR request remind nothing", () => {
      const texts = [
        "/commit autonomous",
        "/pre-pr with cr",
        "/pre-pr-extra",
        "how does the lint work?",
        "did yesterday's push fail?",
        "what is a commit hash?",
        "is the pr #2 in conflict?",
        "a pr #2 está em conflito?",
        "",
      ];

      expect(texts.map((text) => verdictOf(prompt(text)))).toEqual(
        all("silent", texts),
      );
    });
  },
);

describe("require-command: state file", { timeout: HOOK_TIMEOUT }, () => {
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

  it("keeps the branches of /pre-pr in their own file, with only the branch names", () => {
    skill("pre-pr", "session-x");
    git(["switch", "--quiet", "--create", "0043-other"]);
    prompt("/pre-pr with cr", "session-x");
    skill("pre-pr", "session-x");

    expect(stateFiles()).toEqual([
      { name: "session-x", content: "[]" },
      {
        name: "session-x.pre-pr",
        content: JSON.stringify([FIRST_BRANCH, "0043-other"]),
      },
    ]);
  });

  it("the typed /pre-pr clears the command of the turn and records the branch", () => {
    skill("commit", "session-x");
    prompt("/pre-pr", "session-x");

    expect(stateFiles()).toEqual([
      { name: "session-x", content: "[]" },
      { name: "session-x.pre-pr", content: JSON.stringify([FIRST_BRANCH]) },
    ]);
  });

  it("records nothing for /pre-pr when there is no branch", () => {
    const outside = join(stateRoot, "outside");

    mkdirSync(outside);
    runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "pre-pr" },
        cwd: outside,
      },
      "session-x",
    );

    expect(stateFiles()).toEqual([]);
  });

  it("does not fail when /pre-pr cannot write the state directory", () => {
    const blocker = join(stateRoot, "blocker");

    writeFileSync(blocker, "");

    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        session_id: "session-a",
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "pre-pr" },
      }),
      encoding: "utf8",
      env: { ...process.env, TMPDIR: blocker },
    });

    expect(result.status).toBe(0);
  });

  it("treats a corrupted /pre-pr file as no branch reviewed", () => {
    skill("commit", "session-x");

    const dir = join(stateRoot, "claude-require-command");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session-x.pre-pr"), "not json");

    expect(verdictOf(bash("gh pr create --fill", "session-x"))).toBe(
      "deny-pre-pr",
    );
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
