import { spawn } from "node:child_process";
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
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  askIdFor,
  buildAskRecord,
  buildWaitingPing,
  contextBeforeTool,
  delayMs,
  handleTelegramEvent,
  instanceLabel,
  permissionDecision,
  sessionNameFromTranscript,
  telegramActive,
  telegramBotAlive,
  waitForAnswer,
} from "../hooks/telegram.mjs";

const HOOK = join(import.meta.dirname, "..", "hooks", "telegram.mjs");
const NOW = 1_000_000;
const QUESTIONS = [
  {
    question: "Which database?",
    header: "Database",
    multiSelect: false,
    options: [
      { label: "Postgres", description: "Relational" },
      { label: "Redis", preview: "cache" },
    ],
  },
];

let stateDir;
let appDir;
let homeDir;

function transcript(...entries) {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function assistantText(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

const ASK_TOOL_USE = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "AskUserQuestion" }] },
};

function telegramEnv(extra = {}) {
  return commonEnv({ BETTER_CC_TELEGRAM: "1", ...extra });
}

function commonEnv(extra = {}) {
  return {
    TELEGRAM_STATE_DIR: stateDir,
    BETTER_CC_TELEGRAM_DIR: appDir,
    ...extra,
  };
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
    ...telegramEnv(),
    ...extra,
  };
}

function markBotAlive() {
  writeFileSync(join(stateDir, "bot.pid"), String(process.pid));
}

function asksDir() {
  return join(appDir, "asks");
}

function askInput(sessionId = "s1", extra = {}) {
  return {
    session_id: sessionId,
    cwd: "/home/dev/my-project",
    tool_input: { questions: QUESTIONS },
    ...extra,
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "bcct-state-"));
  appDir = mkdtempSync(join(tmpdir(), "bcct-app-"));
  homeDir = mkdtempSync(join(tmpdir(), "bcct-home-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(appDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("delayMs", () => {
  it("returns 240000 ms when the developer has no config", () => {
    expect(delayMs(telegramEnv())).toBe(240_000);
  });

  it("returns the delayMinutes of better-cc-telegram.json in ms", () => {
    writeFileSync(
      join(appDir, "better-cc-telegram.json"),
      JSON.stringify({ delayMinutes: 5 }),
    );

    expect(delayMs(telegramEnv())).toBe(300_000);
  });

  it("falls back to 240000 ms when delayMinutes is not a positive number", () => {
    expect(delayMs({}, { delayMinutes: "abc" })).toBe(240_000);
    expect(delayMs({}, { delayMinutes: 0 })).toBe(240_000);
  });

  it("lets BETTER_CC_TELEGRAM_DELAY_MS override the config, zero included", () => {
    const config = { delayMinutes: 5 };

    expect(delayMs({ BETTER_CC_TELEGRAM_DELAY_MS: "5000" }, config)).toBe(5000);
    expect(delayMs({ BETTER_CC_TELEGRAM_DELAY_MS: "0" }, config)).toBe(0);
    expect(delayMs({ BETTER_CC_TELEGRAM_DELAY_MS: "-1" }, config)).toBe(
      300_000,
    );
  });

  it("treats an empty or blank BETTER_CC_TELEGRAM_DELAY_MS as unset", () => {
    const config = { delayMinutes: 5 };

    expect(delayMs({ BETTER_CC_TELEGRAM_DELAY_MS: "" }, config)).toBe(300_000);
    expect(delayMs({ BETTER_CC_TELEGRAM_DELAY_MS: "  " }, config)).toBe(
      300_000,
    );
  });
});

describe("telegramBotAlive and telegramActive", () => {
  it("treats the bot as up only with a bot.pid of a live process", () => {
    expect(telegramBotAlive(commonEnv(), () => true)).toBe(false);

    writeFileSync(join(stateDir, "bot.pid"), "4242");

    expect(telegramBotAlive(commonEnv(), (pid) => pid === 4242)).toBe(true);
    expect(telegramBotAlive(commonEnv(), () => false)).toBe(false);
  });

  it("is always active on the Telegram instance and on the others only with the bot up", () => {
    expect(telegramActive(telegramEnv(), () => false)).toBe(true);
    expect(telegramActive(commonEnv(), () => false)).toBe(false);

    writeFileSync(join(stateDir, "bot.pid"), "4242");

    expect(telegramActive(commonEnv(), () => true)).toBe(true);
  });
});

describe("contextBeforeTool", () => {
  it("joins the Claude text since the last user entry", () => {
    const text = transcript(
      assistantText("old"),
      { type: "user", message: { content: "do X" } },
      assistantText("Part 1."),
      { type: "attachment" },
      assistantText("Part 2."),
      ASK_TOOL_USE,
    );

    expect(contextBeforeTool(text)).toBe("Part 1.\n\nPart 2.");
  });

  it("stops at the tool result, which is also a user entry", () => {
    const text = transcript(
      assistantText("before the tool"),
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      assistantText("After the result."),
      ASK_TOOL_USE,
    );

    expect(contextBeforeTool(text)).toBe("After the result.");
  });

  it("ignores thinking and broken lines and returns null without text", () => {
    const text = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      "{truncated line",
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "x" }] },
      }),
      JSON.stringify(ASK_TOOL_USE),
    ].join("\n");

    expect(contextBeforeTool(text)).toBeNull();
  });
});

describe("sessionNameFromTranscript and instanceLabel", () => {
  it("prefers the name given to the session, then the title", () => {
    const text = transcript(
      { type: "ai-title", aiTitle: "Automatic title" },
      { type: "custom-title", customTitle: "title" },
      { type: "agent-name", agentName: "back-s3" },
    );

    expect(sessionNameFromTranscript(text)).toBe("back-s3");
    expect(
      sessionNameFromTranscript(
        transcript({ type: "ai-title", aiTitle: "Automatic only" }),
      ),
    ).toBe("Automatic only");
    expect(sessionNameFromTranscript("")).toBeNull();
  });

  it("gives the Telegram instance no label and the others a name or folder#session", () => {
    expect(instanceLabel(askInput(), telegramEnv(), "")).toBeNull();
    expect(
      instanceLabel(
        askInput(),
        commonEnv(),
        transcript({ type: "agent-name", agentName: "back-s3" }),
      ),
    ).toBe("back-s3");
    expect(instanceLabel(askInput("abcdef"), commonEnv(), "")).toBe(
      "my-project#abcd",
    );
  });
});

describe("askIdFor", () => {
  it("uses the session and the time, with file-name-safe characters only", () => {
    expect(askIdFor({ session_id: "s/../1" }, NOW)).toBe("s____1-1000000");
  });
});

describe("buildAskRecord", () => {
  it("builds the request with deadline, instance, context and normalized questions", () => {
    expect(
      buildAskRecord(askInput(), telegramEnv(), NOW, {
        context: "Compared.",
        instance: "back-s3",
      }),
    ).toEqual({
      id: "s1-1000000",
      sessionId: "s1",
      createdAt: NOW,
      dueAt: NOW + 240_000,
      instance: "back-s3",
      context: "Compared.",
      questions: [
        {
          question: "Which database?",
          header: "Database",
          multiSelect: false,
          options: [
            {
              label: "Postgres",
              description: "Relational",
              preview: undefined,
            },
            { label: "Redis", description: undefined, preview: "cache" },
          ],
        },
      ],
    });
  });

  it("returns null without questions", () => {
    expect(
      buildAskRecord({ tool_input: { questions: [] } }, telegramEnv(), NOW),
    ).toBeNull();
    expect(buildAskRecord({}, telegramEnv(), NOW)).toBeNull();
  });
});

describe("buildWaitingPing", () => {
  it("keeps the last message with the deadline and the instance", () => {
    expect(
      buildWaitingPing(
        { session_id: "s1", last_assistant_message: "  I need the ok.  " },
        telegramEnv(),
        NOW,
        "back-s3",
      ),
    ).toEqual({
      sessionId: "s1",
      createdAt: NOW,
      dueAt: NOW + 240_000,
      text: "I need the ok.",
      instance: "back-s3",
    });
  });

  it("does not notify without a message", () => {
    expect(
      buildWaitingPing({ session_id: "s1" }, telegramEnv(), NOW),
    ).toBeNull();
    expect(
      buildWaitingPing({ last_assistant_message: "  " }, telegramEnv(), NOW),
    ).toBeNull();
  });
});

describe("permissionDecision", () => {
  it("allows AskUserQuestion with the answers in the terminal format", () => {
    const toolInput = { questions: QUESTIONS };

    expect(
      permissionDecision(toolInput, { "Which database?": "Postgres" }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: {
            questions: QUESTIONS,
            answers: { "Which database?": "Postgres" },
          },
        },
      },
    });
  });
});

describe("waitForAnswer", () => {
  function writeRecord(id) {
    mkdirSync(asksDir(), { recursive: true });
    writeFileSync(join(asksDir(), `${id}.json`), JSON.stringify({ id }));
  }

  it("returns the answers when the bot writes the file", async () => {
    writeRecord("a1");
    let polls = 0;

    const answers = await waitForAnswer(asksDir(), "a1", {
      wait: async () => {
        polls += 1;
        writeFileSync(
          join(asksDir(), "a1.answer.json"),
          JSON.stringify({ answers: { Q: "A" } }),
        );
      },
    });

    expect(answers).toEqual({ Q: "A" });
    expect(polls).toBe(1);
  });

  it("gives up when the question is answered in the terminal", async () => {
    writeRecord("a1");

    const answers = await waitForAnswer(asksDir(), "a1", {
      wait: async () => {
        writeFileSync(join(asksDir(), "a1.closed"), "");
      },
    });

    expect(answers).toBeNull();
  });

  it("gives up when the request disappears", async () => {
    expect(await waitForAnswer(asksDir(), "missing")).toBeNull();
  });
});

describe("handleTelegramEvent", () => {
  it("does nothing without the Telegram instance or the bot up", () => {
    handleTelegramEvent("permission", askInput(), commonEnv(), NOW);
    handleTelegramEvent(
      "stop",
      { session_id: "s1", last_assistant_message: "hi" },
      commonEnv(),
      NOW,
    );

    expect(readdirSync(stateDir)).toEqual([]);
    expect(readdirSync(appDir)).toEqual([]);
  });

  it("writes the permission request with the instance of who asked", () => {
    markBotAlive();

    const record = handleTelegramEvent(
      "permission",
      askInput(),
      commonEnv(),
      NOW,
    );

    expect(record.instance).toBe("my-project#s1");
    expect(existsSync(join(asksDir(), `${record.id}.json`))).toBe(true);
    expect(readdirSync(stateDir)).toEqual(["bot.pid"]);
  });

  it("closes only the requests of the same session on post and prompt", () => {
    const first = handleTelegramEvent(
      "permission",
      askInput("s1"),
      telegramEnv(),
      NOW,
    );
    const second = handleTelegramEvent(
      "permission",
      askInput("s2"),
      telegramEnv(),
      NOW + 1,
    );

    handleTelegramEvent("post", { session_id: "s1" }, telegramEnv(), NOW);

    expect(existsSync(join(asksDir(), `${first.id}.closed`))).toBe(true);
    expect(existsSync(join(asksDir(), `${second.id}.closed`))).toBe(false);

    handleTelegramEvent("prompt", { session_id: "s2" }, telegramEnv(), NOW);

    expect(existsSync(join(asksDir(), `${second.id}.closed`))).toBe(true);
  });

  it("schedules the notice on stop, cancels it on prompt and only the Telegram instance writes the time", () => {
    markBotAlive();
    handleTelegramEvent(
      "stop",
      { session_id: "s1", cwd: "/x/proj", last_assistant_message: "ok?" },
      commonEnv(),
      NOW,
    );

    const ping = JSON.parse(
      readFileSync(join(appDir, "pings", "s1.json"), "utf8"),
    );

    expect(ping.instance).toBe("proj#s1");

    handleTelegramEvent("prompt", { session_id: "s1" }, commonEnv(), NOW + 5);

    expect(readdirSync(join(appDir, "pings"))).toEqual([]);

    handleTelegramEvent("prompt", { session_id: "tg" }, telegramEnv(), NOW + 9);

    expect(readFileSync(join(appDir, "pings", "last-prompt"), "utf8")).toBe(
      String(NOW + 9),
    );
  });

  it.each([
    [
      "a message from another Claude session",
      'Another Claude session sent a message:\n<cross-session-message from="x">hi</cross-session-message>',
    ],
    ["a cross-session idle notice", "[Cross-session idle notice] peer is idle"],
    ["a cross-session delivery notice", "[Cross-session delivery notice] held"],
    [
      "a Telegram channel message",
      '<channel source="plugin:telegram:telegram" chat_id="1">hello</channel>',
    ],
    [
      "a padded Telegram channel message",
      '\n  <channel source="plugin:telegram:telegram">hello</channel>',
    ],
  ])(
    "leaves the notice, the prompt time and the requests alone on %s",
    (_, prompt) => {
      const ask = handleTelegramEvent(
        "permission",
        askInput("tg"),
        telegramEnv(),
        NOW,
      );
      handleTelegramEvent(
        "stop",
        { session_id: "tg", last_assistant_message: "ok?" },
        telegramEnv(),
        NOW,
      );

      handleTelegramEvent(
        "prompt",
        { session_id: "tg", prompt },
        telegramEnv(),
        NOW + 9,
      );

      expect(readdirSync(join(appDir, "pings"))).toEqual(["tg.json"]);
      expect(existsSync(join(asksDir(), `${ask.id}.closed`))).toBe(false);
    },
  );

  it.each([
    ["typed text", "do X"],
    [
      "text that only quotes a channel tag",
      'read <channel source="plugin:telegram">',
    ],
    ["an empty prompt", ""],
    ["a prompt that is not text", 5],
  ])("still handles a prompt with %s as typed at the terminal", (_, prompt) => {
    const ask = handleTelegramEvent(
      "permission",
      askInput("tg"),
      telegramEnv(),
      NOW,
    );

    handleTelegramEvent(
      "prompt",
      { session_id: "tg", prompt },
      telegramEnv(),
      NOW + 9,
    );

    expect(readFileSync(join(appDir, "pings", "last-prompt"), "utf8")).toBe(
      String(NOW + 9),
    );
    expect(existsSync(join(asksDir(), `${ask.id}.closed`))).toBe(true);
  });
});

describe("hook as a process", () => {
  it("waits for the Telegram answer on permission and prints the decision on stdout", async () => {
    const child = spawn(process.execPath, [HOOK, "permission"], {
      env: childEnv(),
    });
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stdin.end(JSON.stringify(askInput()));

    let recordName;

    for (let attempt = 0; attempt < 50 && !recordName; attempt += 1) {
      await sleep(50);
      recordName = existsSync(asksDir())
        ? readdirSync(asksDir()).find((name) => name.endsWith(".json"))
        : undefined;
    }

    writeFileSync(
      join(asksDir(), recordName.replace(".json", ".answer.json")),
      JSON.stringify({ answers: { "Which database?": "Redis" } }),
    );

    const exitCode = await new Promise((resolve) => child.on("close", resolve));
    const decision = JSON.parse(stdout).hookSpecificOutput.decision;

    expect(exitCode).toBe(0);
    expect(decision.behavior).toBe("allow");
    expect(decision.updatedInput.answers).toEqual({
      "Which database?": "Redis",
    });
  });

  it("exits 0 with no output on invalid stdin", async () => {
    const child = spawn(process.execPath, [HOOK, "permission"], {
      env: childEnv(),
    });
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stdin.end("not json");

    const exitCode = await new Promise((resolve) => child.on("close", resolve));

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });
});
