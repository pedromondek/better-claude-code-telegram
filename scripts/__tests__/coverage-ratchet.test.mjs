import { describe, expect, it, vi } from "vitest";

import config from "../../vitest.config.ts";
import {
  globThresholdKeys,
  ratchetArgsError,
  unmatchedGlobs,
} from "../coverage-ratchet.mjs";

const THRESHOLDS = {
  autoUpdate: false,
  lines: -10,
  statements: -12,
  functions: -3,
  branches: -7,
  perFile: false,
  100: false,
  "plugins/telegram/extensions/i18n.ts": { 100: true, perFile: true },
  "plugins/telegram/extensions/media/**/*.ts": { 100: true, perFile: true },
};
const FILES = [
  "plugins/telegram/extensions/i18n.ts",
  "plugins/telegram/extensions/reply-context.ts",
];

describe("globThresholdKeys", () => {
  it("returns only the glob keys, without metric or option", () => {
    expect(globThresholdKeys(THRESHOLDS)).toEqual([
      "plugins/telegram/extensions/i18n.ts",
      "plugins/telegram/extensions/media/**/*.ts",
    ]);
  });

  it("returns an empty list without thresholds", () => {
    expect(globThresholdKeys(undefined)).toEqual([]);
  });
});

describe("unmatchedGlobs", () => {
  it("points out the glob that matches no file", () => {
    expect(
      unmatchedGlobs(
        [
          "plugins/telegram/extensions/i18n.ts",
          "plugins/telegram/extensions/media/**/*.ts",
        ],
        FILES,
      ),
    ).toEqual(["plugins/telegram/extensions/media/**/*.ts"]);
  });

  it("points out a glob with a typo", () => {
    expect(
      unmatchedGlobs(["plugins/telegram/extension/**/*.ts"], FILES),
    ).toEqual(["plugins/telegram/extension/**/*.ts"]);
  });

  it("accepts a glob with extension braces that matches a file", () => {
    expect(
      unmatchedGlobs(["plugins/telegram/extensions/*.{ts,mts}"], FILES),
    ).toEqual([]);
  });
});

describe("ratchetArgsError", () => {
  it("accepts running without argument", () => {
    expect(ratchetArgsError([])).toBeNull();
  });

  it.each(["--changed", "plugins/telegram", "--coverage.include=x"])(
    "refuses %s, because the floor would come from part of the suite",
    (arg) => {
      expect(ratchetArgsError([arg])).toBe(
        `The ratchet runs the whole suite and takes no argument (got: ${arg}).`,
      );
    },
  );

  it("shows every argument it got", () => {
    expect(ratchetArgsError(["--changed", "plugins/telegram"])).toBe(
      "The ratchet runs the whole suite and takes no argument (got: --changed plugins/telegram).",
    );
  });
});

describe("vitest.config.ts", () => {
  const coverage = config.test.coverage;

  it("writes the JSON reports the changed-lines check and the ratchet read", () => {
    expect(coverage.reporter).toEqual(
      expect.arrayContaining(["json", "json-summary"]),
    );
    expect(coverage.reportsDirectory).toBe("./coverage");
  });

  it("does not touch the floor outside a ratchet run, even when the suite itself runs inside the ratchet", async () => {
    vi.stubEnv("COVERAGE_RATCHET", undefined);

    const { default: plain } = await import("../../vitest.config.ts?plain");

    expect(plain.test.coverage.thresholds.autoUpdate).toBe(false);
  });

  it("in a ratchet run, updates the floor rounding the new value down", async () => {
    vi.stubEnv("COVERAGE_RATCHET", "1");

    const { default: ratchet } = await import("../../vitest.config.ts?ratchet");
    const { autoUpdate } = ratchet.test.coverage.thresholds;

    expect(autoUpdate(87.9)).toBe(87);
    expect(autoUpdate(-64.2)).toBe(-65);
  });
});
