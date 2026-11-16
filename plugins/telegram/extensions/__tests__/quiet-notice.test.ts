import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_FILE } from "../config.ts";
import { MESSAGES } from "../i18n.ts";
import {
  QUIET_NOTICE_FILE,
  createQuietNotice,
  quietPeriodStart,
  type HeldCounts,
} from "../quiet-notice.ts";

const CHAT = "42";
const NOTHING_HELD: HeldCounts = { questions: 0, notices: 0, permissions: 0 };

let appDir = "";

function writeQuietHours(start: string, end: string): void {
  writeFileSync(
    join(appDir, CONFIG_FILE),
    JSON.stringify({ language: "pt-br", quietHours: { start, end } }),
  );
}

function setup(
  held: () => HeldCounts = (): HeldCounts => NOTHING_HELD,
  rejectSend = false,
): {
  sent: { chatId: string; text: string }[];
  logs: string[];
  notice: ReturnType<typeof createQuietNotice>;
} {
  const sent: { chatId: string; text: string }[] = [];
  const logs: string[] = [];
  const notice = createQuietNotice({
    api: {
      sendMessage: (chatId: string, text: string): Promise<unknown> => {
        if (rejectSend) return Promise.reject(new Error("boom"));

        sent.push({ chatId, text });

        return Promise.resolve({});
      },
    },
    appDir,
    allowedChats: () => [CHAT],
    log: (message) => logs.push(message),
    held,
  });

  return { sent, logs, notice };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("TZ", "America/Sao_Paulo");
  appDir = mkdtempSync(join(tmpdir(), "bcct-quiet-notice-"));
  mkdirSync(join(appDir, "pings"), { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(appDir, { recursive: true, force: true });
});

describe("quietPeriodStart", () => {
  it("names a same-day period by its own date and start", (): void => {
    expect(
      quietPeriodStart(new Date(2026, 10, 15, 13, 30), {
        start: "12:00",
        end: "14:00",
      }),
    ).toBe("2026-11-15T12:00");
  });

  it("names an overnight period by the date it started, before and after midnight", (): void => {
    const hours = { start: "22:00", end: "07:00" };

    expect(quietPeriodStart(new Date(2026, 10, 15, 23, 0), hours)).toBe(
      "2026-11-15T22:00",
    );
    expect(quietPeriodStart(new Date(2026, 10, 16, 1, 0), hours)).toBe(
      "2026-11-15T22:00",
    );
    expect(quietPeriodStart(new Date(2026, 0, 1, 1, 0), hours)).toBe(
      "2025-12-31T22:00",
    );
  });

  it("pads the month and the day with a zero", (): void => {
    expect(
      quietPeriodStart(new Date(2026, 0, 5, 13, 0), {
        start: "12:00",
        end: "14:00",
      }),
    ).toBe("2026-01-05T12:00");
  });

  it("counts the minutes of the start, the end and the current time", (): void => {
    const hours = { start: "22:30", end: "07:15" };

    expect(quietPeriodStart(new Date(2026, 10, 16, 3, 0), hours)).toBe(
      "2026-11-15T22:30",
    );
    expect(quietPeriodStart(new Date(2026, 10, 15, 22, 0), hours)).toBe(
      "2026-11-14T22:30",
    );
    expect(
      quietPeriodStart(new Date(2026, 10, 15, 22, 30), {
        start: "22:00",
        end: "07:00",
      }),
    ).toBe("2026-11-15T22:00");
  });

  it("names a same-day period by today even before it starts", (): void => {
    expect(
      quietPeriodStart(new Date(2026, 10, 15, 11, 0), {
        start: "12:00",
        end: "14:00",
      }),
    ).toBe("2026-11-15T12:00");
    expect(
      quietPeriodStart(new Date(2026, 10, 15, 6, 0), {
        start: "07:00",
        end: "07:00",
      }),
    ).toBe("2026-11-15T07:00");
  });
});

describe("quiet notice › start", () => {
  it("tells once per period when quiet hours start, with the end and how to release or stop them", async (): Promise<void> => {
    const { sent, notice } = setup();

    writeQuietHours("22:00", "07:00");
    vi.setSystemTime(new Date(2026, 10, 15, 21, 59));
    await notice.tick();

    expect(sent).toEqual([]);

    vi.setSystemTime(new Date(2026, 10, 15, 22, 0));
    await notice.tick();
    vi.setSystemTime(new Date(2026, 10, 16, 1, 0));
    await notice.tick();

    expect(sent).toEqual([
      {
        chatId: CHAT,
        text: "🌙 Silêncio até 07:00: avisos de espera, perguntas e pedidos de permissão ficam no terminal até lá.\nPara soltar uma pergunta agora: /bcct:release no terminal.\nPara desligar: /bcct:quiet-hours.",
      },
    ]);
  });

  it("tells right away when quiet hours are saved while the current time is already inside them", async (): Promise<void> => {
    const { sent, notice } = setup();

    vi.setSystemTime(new Date(2026, 10, 15, 3, 1));
    await notice.tick();

    expect(sent).toEqual([]);

    writeQuietHours("00:00", "07:00");
    await notice.tick();

    expect(sent.map(({ text }) => text.split("\n")[0])).toEqual([
      "🌙 Silêncio até 07:00: avisos de espera, perguntas e pedidos de permissão ficam no terminal até lá.",
    ]);
  });

  it("keeps the notice of the period across a restart of the channel server", async (): Promise<void> => {
    writeQuietHours("22:00", "07:00");
    vi.setSystemTime(new Date(2026, 10, 15, 23, 0));
    await setup().notice.tick();

    const { sent, notice } = setup();

    await notice.tick();

    expect(sent).toEqual([]);
    expect(readFileSync(join(appDir, "pings", QUIET_NOTICE_FILE), "utf8")).toBe(
      "2026-11-15T22:00",
    );
    expect(
      statSync(join(appDir, "pings", QUIET_NOTICE_FILE)).mode & 0o777,
    ).toBe(0o600);
  });

  it("tells again on the next night", async (): Promise<void> => {
    const { sent, notice } = setup();

    writeQuietHours("22:00", "07:00");
    vi.setSystemTime(new Date(2026, 10, 15, 23, 0));
    await notice.tick();
    vi.setSystemTime(new Date(2026, 10, 16, 8, 0));
    await notice.tick();
    vi.setSystemTime(new Date(2026, 10, 16, 22, 30));
    await notice.tick();

    expect(sent.filter(({ text }) => text.startsWith("🌙"))).toHaveLength(2);
  });

  it("says nothing without quiet hours", async (): Promise<void> => {
    const { sent, notice } = setup(() => ({
      questions: 1,
      notices: 1,
      permissions: 1,
    }));

    vi.setSystemTime(new Date(2026, 10, 15, 23, 0));
    await notice.tick();

    expect(sent).toEqual([]);
  });
});

describe("quiet notice › end", () => {
  it("sums up what was held once quiet hours end, before the items go", async (): Promise<void> => {
    let held: HeldCounts = NOTHING_HELD;
    const { sent, notice } = setup(() => held);

    writeQuietHours("22:00", "07:00");
    vi.setSystemTime(new Date(2026, 10, 15, 23, 0));
    await notice.tick();
    held = { questions: 2, notices: 1, permissions: 0 };
    vi.setSystemTime(new Date(2026, 10, 16, 7, 0));
    await notice.tick();
    await notice.tick();

    expect(sent.map(({ text }) => text).slice(1)).toEqual([
      "☀️ Fim do silêncio. Retido até agora, indo para cá: 2 perguntas, 1 aviso de espera.",
    ]);
  });

  it("sums up whenever any kind was held, whatever the other counts", async (): Promise<void> => {
    for (const held of [
      { questions: 1, notices: 0, permissions: 1 },
      { questions: 1, notices: 1, permissions: 0 },
    ]) {
      rmSync(join(appDir, "pings", QUIET_NOTICE_FILE), { force: true });

      const { sent, notice } = setup(() => held);

      writeQuietHours("22:00", "07:00");
      vi.setSystemTime(new Date(2026, 10, 15, 23, 0));
      await notice.tick();
      vi.setSystemTime(new Date(2026, 10, 16, 7, 0));
      await notice.tick();

      expect(sent.at(-1)?.text.startsWith("☀️ Fim do silêncio.")).toBe(true);
    }
  });

  it("sums up when quiet hours are turned off in the middle of the period", async (): Promise<void> => {
    const { sent, notice } = setup(() => ({
      questions: 0,
      notices: 0,
      permissions: 3,
    }));

    writeQuietHours("22:00", "07:00");
    vi.setSystemTime(new Date(2026, 10, 15, 23, 0));
    await notice.tick();
    writeFileSync(
      join(appDir, CONFIG_FILE),
      JSON.stringify({ language: "pt-br" }),
    );
    await notice.tick();

    expect(sent.at(-1)?.text).toBe(
      "☀️ Fim do silêncio. Retido até agora, indo para cá: 3 pedidos de permissão.",
    );
  });

  it("stays silent at the end when nothing was held", async (): Promise<void> => {
    const { sent, notice } = setup();

    writeQuietHours("22:00", "07:00");
    vi.setSystemTime(new Date(2026, 10, 15, 23, 0));
    await notice.tick();
    vi.setSystemTime(new Date(2026, 10, 16, 7, 30));
    await notice.tick();

    expect(sent).toHaveLength(1);
    expect(readFileSync(join(appDir, "pings", QUIET_NOTICE_FILE), "utf8")).toBe(
      "",
    );
  });
});

describe("quiet notice › failures", () => {
  it("logs a refused message without repeating it on the next cycle", async (): Promise<void> => {
    const { logs, notice } = setup(undefined, true);

    writeQuietHours("22:00", "07:00");
    vi.setSystemTime(new Date(2026, 10, 15, 23, 0));
    await notice.tick();
    await notice.tick();

    expect(logs).toEqual(["silêncio: falha ao avisar no chat: Error: boom"]);
  });

  it("sends nothing and logs when the period cannot be saved, so it never repeats on every cycle", async (): Promise<void> => {
    const { sent, logs, notice } = setup();

    writeQuietHours("22:00", "07:00");
    mkdirSync(join(appDir, "pings", QUIET_NOTICE_FILE));
    vi.setSystemTime(new Date(2026, 10, 15, 23, 0));

    await expect(notice.tick()).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(logs).toEqual([
      expect.stringMatching(
        /^silêncio: falha ao avisar no chat: Error: EISDIR/u,
      ),
    ]);
  });
});

describe("quiet notice texts", () => {
  it("writes the start in English", (): void => {
    expect(MESSAGES["en-us"].quietStarted("07:00")).toBe(
      "🌙 Quiet hours until 07:00: waiting notices, questions and permission requests stay in the terminal until then.\nTo let a question through now: /bcct:release in the terminal.\nTo turn them off: /bcct:quiet-hours.",
    );
  });

  it("counts each kind held, in singular and plural, leaving out the kinds with none", (): void => {
    expect(
      MESSAGES["en-us"].quietEnded({
        questions: 1,
        notices: 2,
        permissions: 1,
      }),
    ).toBe(
      "☀️ Quiet hours are over. Held until now, coming here: 1 question, 2 waiting notices, 1 permission request.",
    );
    expect(
      MESSAGES["en-us"].quietEnded({
        questions: 3,
        notices: 0,
        permissions: 2,
      }),
    ).toBe(
      "☀️ Quiet hours are over. Held until now, coming here: 3 questions, 2 permission requests.",
    );
    expect(
      MESSAGES["en-us"].quietEnded({
        questions: 0,
        notices: 1,
        permissions: 0,
      }),
    ).toBe(
      "☀️ Quiet hours are over. Held until now, coming here: 1 waiting notice.",
    );
    expect(
      MESSAGES["pt-br"].quietEnded({
        questions: 1,
        notices: 2,
        permissions: 1,
      }),
    ).toBe(
      "☀️ Fim do silêncio. Retido até agora, indo para cá: 1 pergunta, 2 avisos de espera, 1 pedido de permissão.",
    );
    expect(MESSAGES["en-us"].quietNoticeFailed("Error: x")).toBe(
      "quiet hours: failed to notify the chat: Error: x",
    );
  });
});
