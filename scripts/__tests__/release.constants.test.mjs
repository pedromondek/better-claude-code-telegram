import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BINARY_NAME,
  RUST_TARGET_DIR,
  binaryFileName,
} from "../release.constants.mjs";

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
