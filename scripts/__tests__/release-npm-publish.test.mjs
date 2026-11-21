import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PACKAGE,
  PLATFORMS,
  REPOSITORY,
} from "../../npm/shim/shim.constants.mjs";
import { distTagOf, run } from "../release-npm-publish.mjs";
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
