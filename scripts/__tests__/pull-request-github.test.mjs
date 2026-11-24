import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  GH_TIMEOUT_MS,
  PULL_REQUESTS_ENDPOINT,
  createGh,
  gh,
  pullRequestSummary,
} from "../pull-request-github.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

function fakeExecFile(output = "") {
  const calls = [];
  const execFile = (file, args, options) => {
    calls.push({ file, args, options });
    return output;
  };

  return { execFile, calls };
}

describe("pull-request-github › gh", () => {
  it("runs gh with the arguments, without stdin, and returns its stdout", () => {
    const { execFile, calls } = fakeExecFile("[]\n");

    const output = createGh(execFile, 15_000)(["api", "user"]);

    expect(output).toBe("[]\n");
    expect(calls).toEqual([
      {
        file: "gh",
        args: ["api", "user"],
        options: {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15_000,
        },
      },
    ]);
  });

  it("gives each gh call a minute by default, so a hung call cannot block the job", () => {
    expect(GH_TIMEOUT_MS).toBe(60_000);
  });

  it("runs the exported gh through execFileSync with the timeout of a minute", () => {
    vi.mocked(execFileSync).mockReturnValue("[]\n");

    const output = gh(["api", "user"]);

    expect(output).toBe("[]\n");
    expect(vi.mocked(execFileSync).mock.calls).toEqual([
      [
        "gh",
        ["api", "user"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        },
      ],
    ]);
  });

  it("lets the error of gh through to the caller", () => {
    const failingGh = createGh(() => {
      throw new Error("spawnSync gh ETIMEDOUT");
    }, 1);

    expect(() => failingGh(["api", "user"])).toThrow("spawnSync gh ETIMEDOUT");
  });
});

describe("pull-request-github › pull requests", () => {
  it("points at the pull requests of the repository gh resolves", () => {
    expect(PULL_REQUESTS_ENDPOINT).toBe("repos/{owner}/{repo}/pulls");
  });

  it("keeps the number, the lock and the sha of the head", () => {
    expect(
      pullRequestSummary({
        number: 12,
        locked: true,
        head: { sha: "abc1234", ref: "0001-feature" },
        title: "a title",
      }),
    ).toEqual({ number: 12, locked: true, head: "abc1234" });
  });

  it("leaves the head undefined when the pull request comes without one", () => {
    expect(pullRequestSummary({ number: 12, locked: false })).toEqual({
      number: 12,
      locked: false,
      head: undefined,
    });
  });
});
