import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ANNOUNCE_CHANNELS,
  ANNOUNCE_PAUSE_MS,
  ANNOUNCE_RETRIES,
  BINARY_NAME,
  RUST_TARGET_DIR,
  TELEGRAM_API,
  binaryFileName,
} from "../release.constants.mjs";

describe("release.constants › announce", () => {
  it("names the stable and the pre-release Telegram channels, one per language", () => {
    expect(ANNOUNCE_CHANNELS).toEqual({
      stable: [
        { chat: "@bcct_tips", language: "en-us" },
        { chat: "@bcct_tips_br", language: "pt-br" },
      ],
      prereleases: [
        { chat: "@bcct_tips_prereleases", language: "en-us" },
        { chat: "@bcct_tips_prelancamentos", language: "pt-br" },
      ],
    });
  });

  it("points at the Bot API, waits a second between posts and retries a 429 three times", () => {
    expect(TELEGRAM_API).toBe("https://api.telegram.org");
    expect(ANNOUNCE_PAUSE_MS).toBe(1000);
    expect(ANNOUNCE_RETRIES).toBe(3);
  });
});

describe("release.constants › binary", () => {
  it("names the binary as the crate of the bcct package", () => {
    const manifest = readFileSync("rust/crates/bcct/Cargo.toml", "utf8");

    expect(manifest).toMatch(new RegExp(`^name = "${BINARY_NAME}"$`, "mu"));
  });

  it("adds the exe suffix only on Windows", () => {
    expect(binaryFileName("win32")).toBe("bcct.exe");
    expect(binaryFileName("linux")).toBe("bcct");
    expect(binaryFileName("darwin")).toBe("bcct");
  });

  it("points the default build folder next to the Rust workspace", () => {
    expect(RUST_TARGET_DIR).toBe("rust/target");
    expect(existsSync(join(dirname(RUST_TARGET_DIR), "Cargo.toml"))).toBe(true);
  });
});
