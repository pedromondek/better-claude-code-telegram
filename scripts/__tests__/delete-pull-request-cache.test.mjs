import { describe, expect, it } from "vitest";

import { run } from "../delete-pull-request-cache.mjs";

function probe(env) {
  const deleted = [];
  const lines = [];
  const errors = [];

  const code = run([], {
    env,
    github: { deleteCaches: (ref) => deleted.push(ref) },
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  });

  return { code, deleted, lines, errors };
}

describe("scripts/delete-pull-request-cache.mjs", () => {
  it("deletes every cache of the merge ref of the closed pull request", () => {
    const { code, deleted, lines } = probe({ PR_NUMBER: "12" });

    expect(code).toBe(0);
    expect(deleted).toEqual(["refs/pull/12/merge"]);
    expect(lines).toEqual(["✓ caches of refs/pull/12/merge deleted"]);
  });

  it("refuses a missing or malformed pull request number without deleting anything", () => {
    for (const [env, shown] of [
      [{}, ""],
      [{ PR_NUMBER: "" }, ""],
      [{ PR_NUMBER: "0" }, "0"],
      [{ PR_NUMBER: "012" }, "012"],
      [{ PR_NUMBER: "12/merge" }, "12/merge"],
    ]) {
      const { code, deleted, errors } = probe(env);

      expect(code).toBe(1);
      expect(deleted).toEqual([]);
      expect(errors).toEqual([
        `✗ PR_NUMBER must be the number of a pull request, not "${shown}"`,
      ]);
    }
  });

  it("fails with the message of gh when the deletion fails", () => {
    const errors = [];

    const code = run([], {
      env: { PR_NUMBER: "3" },
      github: {
        deleteCaches: () => {
          throw new Error("HTTP 403");
        },
      },
      out: () => {},
      err: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors).toEqual(["✗ HTTP 403"]);
  });

  it("takes no argument", () => {
    const errors = [];

    const code = run(["12"], {
      env: { PR_NUMBER: "12" },
      github: { deleteCaches: () => {} },
      out: () => {},
      err: (line) => errors.push(line),
    });

    expect(code).toBe(2);
    expect(errors[0]).toContain("usage");
  });
});
