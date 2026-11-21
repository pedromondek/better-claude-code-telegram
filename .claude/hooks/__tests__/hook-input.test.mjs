import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { projectRelativePath } from "../lib/hook-input.mjs";

const LIB = pathToFileURL(
  join(import.meta.dirname, "..", "lib", "hook-input.mjs"),
);
const PROJECT = "/work/project";

function readFromStdin(input) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { readHookInput } = await import(${JSON.stringify(LIB.href)});
process.stdout.write(JSON.stringify(await readHookInput()));`,
    ],
    { input, encoding: "utf8" },
  );

  expect(result.status).toBe(0);

  return JSON.parse(result.stdout);
}

describe("hook-input › readHookInput", () => {
  it("returns the JSON the hook receives on stdin", () => {
    expect(readFromStdin('{"tool_name":"Bash","cwd":"/repo"}')).toEqual({
      tool_name: "Bash",
      cwd: "/repo",
    });
  });

  it.each(["", "not json", "{"])(
    "returns an empty object for the stdin %j, which is not JSON",
    (input) => {
      expect(readFromStdin(input)).toEqual({});
    },
  );
});

describe("hook-input › projectRelativePath", () => {
  it("returns the path inside the project, with forward slashes", () => {
    expect(projectRelativePath(`${PROJECT}/scripts/a.mjs`, PROJECT)).toBe(
      "scripts/a.mjs",
    );
    expect(projectRelativePath("docs/x.md", PROJECT)).toBe("docs/x.md");
  });

  it("returns the path of a folder whose name starts with two dots", () => {
    expect(projectRelativePath(`${PROJECT}/..cache/x`, PROJECT)).toBe(
      "..cache/x",
    );
  });

  it.each([
    [PROJECT, "the project folder itself"],
    ["/work", "the parent folder"],
    ["/work/other/x.mjs", "a file of another folder"],
    ["../other/x.mjs", "a relative path that leaves the project"],
  ])("returns undefined for %s, %s", (file) => {
    expect(projectRelativePath(file, PROJECT)).toBeUndefined();
  });
});
