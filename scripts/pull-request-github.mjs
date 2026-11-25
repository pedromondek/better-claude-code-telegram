import { execFileSync } from "node:child_process";

export const GH_TIMEOUT_MS = 60_000;

export const PULL_REQUESTS_ENDPOINT = "repos/{owner}/{repo}/pulls";

export function createGh(execFile, timeout) {
  return (args) =>
    execFile("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
}

export const pullRequestSummary = ({ number, locked, head }) => ({
  number,
  locked,
  head: head?.sha,
});

export const gh = createGh(execFileSync, GH_TIMEOUT_MS);
