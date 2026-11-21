import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_FILE } from "../config.ts";
import { MESSAGES, type Messages } from "../i18n.ts";
import {
  TRANSCRIBE_SCRIPT,
  TRANSCRIPTION_MODELS,
  createTranscriber,
  formatTranscription,
  readTranscriptionModel,
  whisperPython,
} from "../transcription.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();

  return {
    ...actual,
    readdirSync: vi.fn<typeof actual.readdirSync>(actual.readdirSync),
  };
});

const DEV = "42";
const PT = MESSAGES["pt-br"];
const EN = MESSAGES["en-us"];

type RunPython = (
  python: string,
  args: string[],
) => Promise<{ stdout: string }>;

interface PythonCall {
  python: string;
  args: string[];
  audioExists: boolean;
}

interface SetupOptions {
  runPython?: RunPython;
  fetchOk?: boolean;
  messages?: () => Messages;
  filePath?: string;
  failTyping?: boolean;
}

let stateDir = "";
let appDir = "";

function configure(model: string | null = "small", extra = {}): void {
  writeFileSync(
    join(appDir, CONFIG_FILE),
    JSON.stringify({
      ...extra,
      transcription: model ? { model } : null,
    }),
  );
}

function installFakePython(): void {
  mkdirSync(join(appDir, "whisper", "venv", "bin"), { recursive: true });
  writeFileSync(whisperPython(appDir), "");
}

function setup({
  runPython,
  fetchOk = true,
  messages,
  filePath = "voice/file.oga",
  failTyping = false,
}: SetupOptions = {}): {
  transcribe: ReturnType<typeof createTranscriber>;
  sent: { chatId: string; text: string }[];
  actions: { chatId: string; action: string }[];
  fetched: Parameters<typeof fetch>[0][];
  logs: string[];
  calls: PythonCall[];
} {
  const sent: { chatId: string; text: string }[] = [];
  const actions: { chatId: string; action: string }[] = [];
  const fetched: Parameters<typeof fetch>[0][] = [];
  const logs: string[] = [];
  const calls: PythonCall[] = [];
  const transcribe = createTranscriber({
    api: {
      getFile: () =>
        Promise.resolve(filePath === "" ? {} : { file_path: filePath }),
      sendMessage: (chatId, text) => {
        sent.push({ chatId, text });

        return Promise.resolve();
      },
      sendChatAction: (chatId, action) => {
        actions.push({ chatId, action });

        return failTyping
          ? Promise.reject(new Error("typing refused"))
          : Promise.resolve();
      },
    },
    stateDir,
    appDir,
    allowedChats: () => [DEV],
    fileUrl: (path) => `http://fake/${path}`,
    log: (message) => logs.push(message),
    fetchImpl: (url) => {
      fetched.push(url);

      return Promise.resolve(
        new Response("ogg", { status: fetchOk ? 200 : 500 }),
      );
    },
    runPython:
      runPython ??
      ((python, args): Promise<{ stdout: string }> => {
        calls.push({
          python,
          args,
          audioExists: existsSync(args.at(-1) ?? ""),
        });

        return Promise.resolve({
          stdout: JSON.stringify({ text: " Oi, Claude. " }),
        });
      }),
    ...(messages ? { messages } : {}),
  });

  return { transcribe, sent, actions, fetched, logs, calls };
}

function printingPython(stdout: string): RunPython {
  return () => Promise.resolve({ stdout });
}

function failingPython(message: string): RunPython {
  return () => Promise.reject(new Error(message));
}

function emptyPython(): RunPython {
  return () => Promise.resolve({ stdout: JSON.stringify({ text: "  " }) });
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "bcct-transcription-channel-"));
  appDir = mkdtempSync(join(tmpdir(), "bcct-transcription-app-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(appDir, { recursive: true, force: true });
});

describe("TRANSCRIPTION_MODELS", () => {
  it("lists base, small and medium", (): void => {
    expect(TRANSCRIPTION_MODELS).toEqual(["base", "small", "medium"]);
  });
});

interface WhisperPythonCase {
  name: string;
  platform: NodeJS.Platform;
  appDir: string;
  python: string;
}

const WHISPER_PYTHON_CASES = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures", "whisper-python.json"),
    "utf8",
  ),
) as WhisperPythonCase[];

describe("whisperPython", () => {
  it("points at the Python of the whisper/venv environment that the setup creates", (): void => {
    expect(whisperPython("/app")).toBe("/app/whisper/venv/bin/python");
  });

  it("finds the Python of the venv of each platform, the same path the setup writes", (): void => {
    expect(WHISPER_PYTHON_CASES.map(({ platform }) => platform)).toEqual([
      "linux",
      "darwin",
      "win32",
    ]);

    for (const entry of WHISPER_PYTHON_CASES) {
      expect({
        name: entry.name,
        python: whisperPython(entry.appDir, entry.platform),
      }).toEqual({ name: entry.name, python: entry.python });
    }
  });
});

describe("readTranscriptionModel", () => {
  it("reads the model from better-cc-telegram.json and rejects an unknown model", (): void => {
    expect(readTranscriptionModel(appDir)).toBeNull();

    configure("medium");
    expect(readTranscriptionModel(appDir)).toBe("medium");

    configure("enorme");
    expect(readTranscriptionModel(appDir)).toBeNull();

    configure(null);
    expect(readTranscriptionModel(appDir)).toBeNull();
  });
});

describe("formatTranscription", () => {
  it("warns that the text came from an audio in pt-br", (): void => {
    expect(formatTranscription("Oi", PT)).toBe(
      "🎤 Transcrição do áudio:\n\nOi",
    );
  });

  it("warns that the text came from an audio in en-us", (): void => {
    expect(formatTranscription("Hi", EN)).toBe("🎤 Audio transcription:\n\nHi");
  });
});

describe("createTranscriber", () => {
  it("downloads, transcribes with the configured model and deletes the audio", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe, calls, logs } = setup({ messages: () => PT });

    expect(await transcribe("file-1", DEV)).toBe("Oi, Claude.");
    expect(calls[0].args.slice(0, 3)).toEqual([
      TRANSCRIBE_SCRIPT,
      "--model",
      "small",
    ]);
    expect(calls[0].python).toBe(whisperPython(appDir));
    expect(calls[0].audioExists).toBe(true);
    expect(readdirSync(join(stateDir, "inbox"))).toEqual([]);
    expect(logs).toEqual(["áudio transcrito com o modelo small: Oi, Claude."]);
  });

  it("does not transcribe audio from someone outside the allowlist", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe, calls } = setup();

    expect(await transcribe("file-1", "7")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("stays out without transcription configured or without the Python environment", async (): Promise<void> => {
    installFakePython();
    const withoutConfig = setup();

    expect(await withoutConfig.transcribe("file-1", DEV)).toBeNull();

    rmSync(join(appDir, "whisper"), { recursive: true });
    configure("small");
    const withoutPython = setup();

    expect(await withoutPython.transcribe("file-1", DEV)).toBeNull();
    expect(withoutPython.calls).toEqual([]);
  });

  it("on failure warns on Telegram, deletes the audio and returns null to go on as an attachment", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe, sent } = setup({
      runPython: failingPython("timeout"),
      messages: () => PT,
    });

    expect(await transcribe("file-1", DEV)).toBeNull();
    expect(sent).toEqual([
      {
        chatId: DEV,
        text: "⚠️ Não consegui transcrever o áudio; ele foi como anexo para o Claude.",
      },
    ]);
    expect(readdirSync(join(stateDir, "inbox"))).toEqual([]);
  });

  it("treats an empty transcription as a failure", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe, sent } = setup({ runPython: emptyPython() });

    expect(await transcribe("file-1", DEV)).toBeNull();
    expect(sent.length).toBe(1);
  });

  it("deletes leftover audio from a previous process on startup", (): void => {
    mkdirSync(join(stateDir, "inbox"), { recursive: true });
    writeFileSync(join(stateDir, "inbox", "voice-123.ogg"), "x");
    writeFileSync(join(stateDir, "inbox", "foto.jpg"), "x");

    setup();

    expect(readdirSync(join(stateDir, "inbox"))).toEqual(["foto.jpg"]);
  });

  it("on startup keeps the files whose name only contains the name of its audio", (): void => {
    const inbox = join(stateDir, "inbox");

    mkdirSync(inbox, { recursive: true });

    for (const name of ["voice-1.ogg", "my-voice-2.ogg", "voice-3.ogg.part"]) {
      writeFileSync(join(inbox, name), "x");
    }

    setup();

    expect(readdirSync(inbox).toSorted()).toEqual([
      "my-voice-2.ogg",
      "voice-3.ogg.part",
    ]);
  });

  it("on startup goes on deleting the leftovers when one was already removed by someone else", (): void => {
    const inbox = join(stateDir, "inbox");

    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "voice-2.ogg"), "x");
    vi.mocked(readdirSync).mockReturnValueOnce([
      "voice-1.ogg",
      "voice-2.ogg",
    ] as unknown as ReturnType<typeof readdirSync>);

    setup();

    expect(readdirSync(inbox)).toEqual([]);
  });

  it("shows that it is typing on the chat of the sender while it transcribes", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe, actions } = setup();

    await transcribe("file-1", DEV);

    expect(actions).toEqual([{ chatId: DEV, action: "typing" }]);
  });

  it("returns the transcript without a warning when Telegram refuses the typing action", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe, actions, sent, calls, logs } = setup({
      failTyping: true,
      messages: () => PT,
    });

    expect(await transcribe("file-1", DEV)).toBe("Oi, Claude.");
    expect(actions).toEqual([{ chatId: DEV, action: "typing" }]);
    expect(calls.length).toBe(1);
    expect(sent).toEqual([]);
    expect(logs).toEqual(["áudio transcrito com o modelo small: Oi, Claude."]);
    expect(readdirSync(join(stateDir, "inbox"))).toEqual([]);
  });

  it("downloads the audio private to the user while Python reads it", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const modes: number[] = [];
    const { transcribe } = setup({
      runPython: (_python, args) => {
        modes.push(statSync(args.at(-1) ?? "").mode & 0o777);

        return Promise.resolve({ stdout: JSON.stringify({ text: "Oi" }) });
      },
    });

    expect(await transcribe("file-1", DEV)).toBe("Oi");
    expect(modes).toEqual([0o600]);
  });

  it("treats a Telegram file without a path as an unavailable audio and never downloads it", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe, fetched, logs, calls } = setup({
      filePath: "",
      messages: () => EN,
    });

    expect(await transcribe("file-1", DEV)).toBeNull();
    expect(fetched).toEqual([]);
    expect(calls).toEqual([]);
    expect(logs).toEqual([
      "failed to transcribe the audio: Error: audio file unavailable",
    ]);
  });

  it("returns the transcript even when the audio is already gone from the inbox", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe } = setup({
      runPython: (_python, args) => {
        rmSync(args.at(-1) ?? "");

        return Promise.resolve({ stdout: JSON.stringify({ text: "Oi" }) });
      },
    });

    expect(await transcribe("file-1", DEV)).toBe("Oi");
  });

  it.each([
    ["null", "null"],
    ["a number", "5"],
    ["a string", '"Oi"'],
    ["a list", '["Oi"]'],
    ["an object without text", '{"segments": []}'],
    ["a text that is not a string", '{"text": 5}'],
  ])(
    "treats an output that is %s as an empty transcription",
    async (_shape, stdout): Promise<void> => {
      configure("small");
      installFakePython();
      const { transcribe, logs } = setup({
        runPython: printingPython(stdout),
        messages: () => EN,
      });

      expect(await transcribe("file-1", DEV)).toBeNull();
      expect(logs).toEqual([
        "failed to transcribe the audio: Error: empty transcription",
      ]);
    },
  );
});

describe("createTranscriber language", () => {
  it("passes --language pt and the audio path last with messages set to pt-br", async (): Promise<void> => {
    configure("base");
    installFakePython();
    const { transcribe, calls } = setup({ messages: () => PT });

    await transcribe("file-1", DEV);

    expect(calls[0].args.slice(0, 5)).toEqual([
      TRANSCRIBE_SCRIPT,
      "--model",
      "base",
      "--language",
      "pt",
    ]);
    expect(calls[0].args.length).toBe(6);
    expect(calls[0].args[5]).toMatch(/voice-\d+\.ogg$/);
  });

  it("passes --language en with messages set to en-us", async (): Promise<void> => {
    configure("medium");
    installFakePython();
    const { transcribe, calls } = setup({ messages: () => EN });

    await transcribe("file-1", DEV);

    expect(calls[0].args.slice(0, 5)).toEqual([
      TRANSCRIBE_SCRIPT,
      "--model",
      "medium",
      "--language",
      "en",
    ]);
  });

  it("follows the language of the config when messages is not given", async (): Promise<void> => {
    configure("small", { language: "pt-br" });
    installFakePython();
    const { transcribe, calls, logs } = setup();

    expect(await transcribe("file-1", DEV)).toBe("Oi, Claude.");
    expect(calls[0].args.slice(3, 5)).toEqual(["--language", "pt"]);
    expect(logs).toEqual(["áudio transcrito com o modelo small: Oi, Claude."]);
  });

  it("falls back to en-us when there is no language in the config and messages is not given", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe, calls, logs } = setup();

    expect(await transcribe("file-1", DEV)).toBe("Oi, Claude.");
    expect(calls[0].args.slice(3, 5)).toEqual(["--language", "en"]);
    expect(logs).toEqual([
      "audio transcribed with the small model: Oi, Claude.",
    ]);
  });
});

describe("createTranscriber texts", () => {
  it("warns in en-us and logs the failure with messages set to en-us", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const { transcribe, sent, logs } = setup({
      runPython: failingPython("timeout"),
      messages: () => EN,
    });

    expect(await transcribe("file-1", DEV)).toBeNull();
    expect(sent).toEqual([
      {
        chatId: DEV,
        text: "⚠️ I couldn't transcribe the audio; it went to Claude as an attachment.",
      },
    ]);
    expect(logs).toEqual(["failed to transcribe the audio: Error: timeout"]);
  });

  it("warns in pt-br and logs the failure with the config language when messages is not given", async (): Promise<void> => {
    configure("small", { language: "pt-br" });
    installFakePython();
    const { transcribe, sent, logs } = setup({
      runPython: failingPython("timeout"),
    });

    expect(await transcribe("file-1", DEV)).toBeNull();
    expect(sent[0].text).toBe(
      "⚠️ Não consegui transcrever o áudio; ele foi como anexo para o Claude.",
    );
    expect(logs).toEqual(["falha ao transcrever o áudio: Error: timeout"]);
  });

  it("names the empty transcription in the log in each language", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const english = setup({ runPython: emptyPython(), messages: () => EN });
    const portuguese = setup({ runPython: emptyPython(), messages: () => PT });

    await english.transcribe("file-1", DEV);
    await portuguese.transcribe("file-1", DEV);

    expect(english.logs).toEqual([
      "failed to transcribe the audio: Error: empty transcription",
    ]);
    expect(portuguese.logs).toEqual([
      "falha ao transcrever o áudio: Error: transcrição vazia",
    ]);
  });

  it("names the unavailable audio in the log in each language and never runs Python", async (): Promise<void> => {
    configure("small");
    installFakePython();
    const english = setup({ fetchOk: false, messages: () => EN });
    const portuguese = setup({ fetchOk: false, messages: () => PT });

    expect(await english.transcribe("file-1", DEV)).toBeNull();
    expect(await portuguese.transcribe("file-1", DEV)).toBeNull();

    expect(english.logs).toEqual([
      "failed to transcribe the audio: Error: audio file unavailable",
    ]);
    expect(portuguese.logs).toEqual([
      "falha ao transcrever o áudio: Error: arquivo de áudio indisponível",
    ]);
    expect(english.calls).toEqual([]);
    expect(portuguese.calls).toEqual([]);
  });
});

function transcriberWith(
  api: Partial<Parameters<typeof createTranscriber>[0]["api"]>,
): ReturnType<typeof createTranscriber> {
  return createTranscriber({
    api: {
      getFile: () => Promise.resolve({ file_path: "voice/file.oga" }),
      sendMessage: () => Promise.resolve(),
      sendChatAction: () => Promise.resolve(),
      ...api,
    },
    stateDir,
    appDir,
    allowedChats: () => [DEV],
    fileUrl: (filePath) => `http://fake/${filePath}`,
    log: () => undefined,
    fetchImpl: () => Promise.resolve(new Response("ogg", { status: 200 })),
    messages: () => EN,
  });
}

describe("createTranscriber with the real process runner", () => {
  it("runs the Python of the whisper environment with the script and reads its JSON", async (): Promise<void> => {
    configure("small");
    mkdirSync(join(appDir, "whisper", "venv", "bin"), { recursive: true });
    writeFileSync(
      whisperPython(appDir),
      `#!/bin/sh\n[ "$1" = "${TRANSCRIBE_SCRIPT}" ] || exit 9\necho '{"text": " Oi, Claude. "}'\n`,
      { mode: 0o755 },
    );

    expect(await transcriberWith({})("file-1", DEV)).toBe("Oi, Claude.");
  });

  it("reads an output of Python larger than one megabyte", async (): Promise<void> => {
    configure("small");
    mkdirSync(join(appDir, "whisper", "venv", "bin"), { recursive: true });
    writeFileSync(
      whisperPython(appDir),
      `#!/bin/sh\nprintf '{"text": "'\nhead -c 2000000 /dev/zero | tr '\\0' a\nprintf '"}'\n`,
      { mode: 0o755 },
    );

    expect(await transcriberWith({})("file-1", DEV)).toBe(
      "a".repeat(2_000_000),
    );
  });

  it("returns null when even the failure warning cannot reach the chat", async (): Promise<void> => {
    configure("small");
    mkdirSync(join(appDir, "whisper", "venv", "bin"), { recursive: true });
    writeFileSync(whisperPython(appDir), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const transcribe = transcriberWith({
      sendMessage: () => Promise.reject(new Error("chat gone")),
    });

    expect(await transcribe("file-1", DEV)).toBeNull();
  });
});
