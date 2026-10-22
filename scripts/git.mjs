import { execFileSync } from "node:child_process";

const MAX_GIT_OUTPUT_BYTES = 512 * 1024 * 1024;

export function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
