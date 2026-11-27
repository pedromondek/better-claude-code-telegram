import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PACKAGE,
  PLATFORMS,
  REPOSITORY,
} from "../../npm/shim/shim.constants.mjs";
import {
  createNpm,
  distTagOf,
  installCommand,
  run,
} from "../release-npm-publish.mjs";
import {
  DIST_TAGS,
  MIN_STAGE_NPM,
  RELEASE_ENVIRONMENT,
  RELEASE_WORKFLOW,
} from "../release.constants.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const FOLDER = "/tmp/dist/npm";
const PLATFORM_PACKAGES = PLATFORMS.map((name) => `${PACKAGE}-${name}`);

function fakeNpm({ version = "11.19.0", published = [] } = {}) {
  const calls = [];
  const npm = {
    version: () => version,
    published: (spec) => {
      calls.push(["published", spec]);
      return published.includes(spec);
    },
    stagePublish: (stage) => calls.push(["stagePublish", stage]),
    trust: (trust) => calls.push(["trust", trust]),
    sleep: (ms) => calls.push(["sleep", ms]),
  };

  return { npm, calls };
}

function runWith(args, { env = {}, npm: options } = {}) {
  const { npm, calls } = fakeNpm(options);
  const out = [];
  const err = [];
  const code = run(args, {
    env: { VERSION: "0.2.0-beta.1", ...env },
    npm,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return { code, out, err, calls };
}

describe("installCommand", () => {
  it.each([
    ["0.2.0-alpha.3", "npx @pedromondek/better-claude-code-telegram@alpha"],
    ["0.2.0-beta.1", "npx @pedromondek/better-claude-code-telegram@beta"],
    ["0.2.0-rc.2", "npx @pedromondek/better-claude-code-telegram@next"],
  ])("installs %s from the dist-tag of its stage", (version, command) => {
    expect(installCommand(version)).toBe(command);
  });

  it("installs a stable version with no tag, as npx takes latest by default", () => {
    expect(installCommand("0.2.0")).toBe(
      "npx @pedromondek/better-claude-code-telegram",
    );
  });
});

describe("distTagOf", () => {
  it.each([
    ["0.2.0-alpha.3", "alpha"],
    ["0.2.0-beta.1", "beta"],
    ["0.2.0-rc.2", "next"],
    ["0.2.0", "latest"],
  ])(
    "tags %s as %s, since npm moves latest when no tag is given",
    (version, tag) => {
      expect(distTagOf(version)).toBe(tag);
    },
  );

  it("keeps the tags of the versioning table", () => {
    expect(DIST_TAGS).toEqual({
      alpha: "alpha",
      beta: "beta",
      rc: "next",
      stable: "latest",
    });
  });
});

describe("stage", () => {
  it("stages the 6 platform packages and then the main one, which depends on them, public and on the tag of the stage", () => {
    const { code, calls, out } = runWith(["stage", FOLDER]);
    const staged = calls.filter(([name]) => name === "stagePublish");

    expect(code).toBe(0);
    expect(staged.map(([, stage]) => stage)).toEqual(
      [...PLATFORM_PACKAGES, PACKAGE].map((name) => ({
        dir: join(FOLDER, name),
        tag: "beta",
      })),
    );
    expect(out.at(-1)).toBe(
      "✓ 7 packages of v0.2.0-beta.1 staged on beta: approve them in one batch on the Staged Packages tab of npmjs.com",
    );
  });

  it("skips a package whose version is already on npm, so a run that stopped halfway goes on", () => {
    const { calls, out } = runWith(["stage", FOLDER], {
      npm: { published: [`${PLATFORM_PACKAGES[0]}@0.2.0-beta.1`] },
    });

    expect(
      calls
        .filter(([name]) => name === "stagePublish")
        .map(([, stage]) => stage.dir),
    ).not.toContain(join(FOLDER, PLATFORM_PACKAGES[0]));
    expect(out).toContain(
      `- ${PLATFORM_PACKAGES[0]}@0.2.0-beta.1 is already on npm`,
    );
  });

  it("refuses an npm older than the one staged publishing needs, staging nothing", () => {
    const { code, err, calls } = runWith(["stage", FOLDER], {
      npm: { version: "11.14.9" },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ npm ${MIN_STAGE_NPM} or later stages packages; this runner has 11.14.9`,
    ]);
    expect(calls.some(([name]) => name === "stagePublish")).toBe(false);
  });

  it("refuses a version that is not a release version", () => {
    const { code, err } = runWith(["stage", FOLDER], {
      env: { VERSION: "0.0.0-stage" },
    });

    expect(code).toBe(1);
    expect(err[0]).toMatch(/^✗ /u);
  });
});

describe("trust", () => {
  it("lets release.yml in the release environment stage each of the 7 packages, pausing between calls as the npm docs ask", () => {
    const { code, calls } = runWith(["trust"]);
    const trusted = calls.filter(([name]) => name === "trust");

    expect(code).toBe(0);
    expect(trusted.map(([, trust]) => trust)).toEqual(
      [...PLATFORM_PACKAGES, PACKAGE].map((name) => ({
        name,
        file: RELEASE_WORKFLOW,
        repository: REPOSITORY,
        environment: RELEASE_ENVIRONMENT,
      })),
    );
    expect(calls.filter(([name]) => name === "sleep")).toHaveLength(6);
    expect(calls.find(([name]) => name === "sleep")[1]).toBe(2000);
  });

  it("refuses an npm older than the one npm trust needs", () => {
    const { code, calls } = runWith(["trust"], { npm: { version: "11.5.1" } });

    expect(code).toBe(1);
    expect(calls.some(([name]) => name === "trust")).toBe(false);
  });
});

const SPEC = `${PLATFORM_PACKAGES[0]}@0.1.0-alpha.1`;
const E404_JSON = JSON.stringify({
  error: {
    code: "E404",
    summary: `Not Found - GET https://registry.npmjs.org/${PLATFORM_PACKAGES[0]}`,
    detail: "The requested resource could not be found.",
  },
});

function npmWithSpawn(result) {
  const spawns = [];
  const npm = createNpm((command, args, options) => {
    spawns.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "", ...result };
  });

  return { npm, spawns };
}

describe("npm › published", () => {
  it("answers true when npm view prints the version", () => {
    const { npm, spawns } = npmWithSpawn({ stdout: '"0.1.0-alpha.1"\n' });

    expect(npm.published(SPEC)).toBe(true);
    expect(spawns[0].args).toEqual(["view", SPEC, "version", "--json"]);
  });

  it("answers false for an E404 that comes only as JSON on stdout, as with the silent loglevel of npm run --silent", () => {
    const { npm } = npmWithSpawn({ status: 1, stdout: E404_JSON, stderr: "" });

    expect(npm.published(SPEC)).toBe(false);
  });

  it("answers false for an E404 that npm logs on stderr", () => {
    const { npm } = npmWithSpawn({
      status: 1,
      stdout: "",
      stderr: "npm error code E404\nnpm error 404 Not Found",
    });

    expect(npm.published(SPEC)).toBe(false);
  });

  it("throws the summary of any other npm error, such as E401", () => {
    const { npm } = npmWithSpawn({
      status: 1,
      stdout: JSON.stringify({
        error: { code: "E401", summary: "Unable to authenticate" },
      }),
      stderr: "",
    });

    expect(() => npm.published(SPEC)).toThrow(
      `npm view ${SPEC} failed: E401 Unable to authenticate`,
    );
  });

  it("throws on a failure with no JSON error and nothing on stderr", () => {
    const { npm } = npmWithSpawn({ status: 1, stdout: "", stderr: "" });

    expect(() => npm.published(SPEC)).toThrow(`npm view ${SPEC} failed`);
  });
});

describe("npm › stagePublish", () => {
  it("stages with the notice loglevel, so a failure is not hidden by the silent loglevel of npm run --silent", () => {
    const { npm, spawns } = npmWithSpawn({ status: 0 });

    npm.stagePublish({ dir: `${FOLDER}/${PACKAGE}`, tag: "alpha" });

    expect(spawns[0].args).toEqual([
      "stage",
      "publish",
      `${FOLDER}/${PACKAGE}`,
      "--tag",
      "alpha",
      "--access",
      "public",
      "--loglevel",
      "notice",
    ]);
  });

  it("throws with what npm wrote on stderr when the stage fails", () => {
    const { npm } = npmWithSpawn({
      status: 254,
      stderr: "npm error code ENOENT\n",
    });

    expect(() =>
      npm.stagePublish({ dir: `${FOLDER}/${PACKAGE}`, tag: "alpha" }),
    ).toThrow("failed: npm error code ENOENT");
  });
});

describe("npm › trust", () => {
  it("runs npm trust on the terminal, so npm can ask for the one-time password of the account", () => {
    const { npm, spawns } = npmWithSpawn({ status: 0 });

    npm.trust({
      name: PACKAGE,
      file: RELEASE_WORKFLOW,
      repository: REPOSITORY,
      environment: RELEASE_ENVIRONMENT,
    });

    expect(spawns[0]).toEqual({
      command: "npm",
      args: [
        "trust",
        "github",
        PACKAGE,
        "--file",
        RELEASE_WORKFLOW,
        "--repo",
        REPOSITORY,
        "--env",
        RELEASE_ENVIRONMENT,
        "--allow-stage-publish",
        "--yes",
      ],
      options: { stdio: "inherit" },
    });
  });

  it("throws when npm trust fails", () => {
    const { npm } = npmWithSpawn({ status: 1 });

    expect(() =>
      npm.trust({
        name: PACKAGE,
        file: RELEASE_WORKFLOW,
        repository: REPOSITORY,
        environment: RELEASE_ENVIRONMENT,
      }),
    ).toThrow(`npm trust github ${PACKAGE} failed`);
  });
});

describe("run", () => {
  it.each([[[]], [["stage"]], [["trust", "x"]], [["nope"]]])(
    "a usage error exits 2 (%j)",
    (args) => {
      expect(runWith(args)).toMatchObject({
        code: 2,
        err: [
          "usage: npm run release:npm:publish -- stage <packages folder> (version in VERSION) | trust",
        ],
      });
    },
  );

  it("is the release:npm:publish npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["release:npm:publish"]).toBe(
      "node scripts/release-npm-publish.mjs",
    );
  });

  it("names the workflow and the environment that exist", () => {
    const workflow = readFileSync(
      join(ROOT, ".github/workflows", RELEASE_WORKFLOW),
      "utf8",
    );

    expect(workflow).toContain(`environment: ${RELEASE_ENVIRONMENT}\n`);
  });
});
