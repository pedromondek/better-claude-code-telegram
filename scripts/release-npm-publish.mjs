import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { PACKAGE, PLATFORMS, REPOSITORY } from "../npm/shim/shim.constants.mjs";
import {
  DIST_TAGS,
  MIN_STAGE_NPM,
  RELEASE_ENVIRONMENT,
  RELEASE_WORKFLOW,
  TRUST_PAUSE_MS,
} from "./release.constants.mjs";
import { parseVersion } from "./version.mjs";

const USAGE =
  "usage: npm run release:npm:publish -- stage <packages folder> (version in VERSION) | trust";

export function distTagOf(version) {
  return DIST_TAGS[parseVersion(version).stage ?? "stable"];
}

function packagesInOrder() {
  return [...PLATFORMS.map((name) => `${PACKAGE}-${name}`), PACKAGE];
}

function numbers(version) {
  return version.split(".").map(Number);
}

function isAtLeast(version, minimum) {
  const [have, need] = [numbers(version), numbers(minimum)];
  const index = need.findIndex((part, at) => have[at] !== part);

  return index === -1 || have[index] > need[index];
}

function requireNpm(npm) {
  const version = npm.version();

  if (!isAtLeast(version, MIN_STAGE_NPM)) {
    throw new Error(
      `npm ${MIN_STAGE_NPM} or later stages packages; this runner has ${version}`,
    );
  }
}

function stage({ env, npm, folder, out }) {
  const version = env.VERSION;
  const tag = distTagOf(version);

  requireNpm(npm);

  for (const name of packagesInOrder()) {
    const spec = `${name}@${version}`;

    if (npm.published(spec)) {
      out(`- ${spec} is already on npm`);
      continue;
    }

    npm.stagePublish({ dir: join(folder, name), tag });
    out(`✓ ${spec} staged`);
  }

  out(
    `✓ ${packagesInOrder().length} packages of v${version} staged on ${tag}: approve them in one batch on the Staged Packages tab of npmjs.com`,
  );
}

function trust({ npm, out }) {
  requireNpm(npm);

  packagesInOrder().forEach((name, index) => {
    if (index > 0) {
      npm.sleep(TRUST_PAUSE_MS);
    }

    npm.trust({
      name,
      file: RELEASE_WORKFLOW,
      repository: REPOSITORY,
      environment: RELEASE_ENVIRONMENT,
    });
    out(`✓ ${name} trusts ${RELEASE_WORKFLOW} in ${RELEASE_ENVIRONMENT}`);
  });
}

export function run(args, { env, npm, out, err }) {
  const [command, folder, ...rest] = args;
  const action =
    command === "stage" && folder !== undefined && rest.length === 0
      ? () => stage({ env, npm, folder, out })
      : command === "trust" && folder === undefined
        ? () => trust({ npm, out })
        : null;

  if (action === null) {
    err(USAGE);
    return 2;
  }

  try {
    action();
    return 0;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const NOT_FOUND = "E404";

function jsonError(stdout) {
  try {
    const parsed = JSON.parse(stdout);

    return parsed?.error instanceof Object ? parsed.error : null;
  } catch {
    return null;
  }
}

export function createNpm(spawn) {
  function npmCli(args) {
    const result = spawn("npm", args, { encoding: "utf8" });

    if (result.error) {
      throw result.error;
    }

    return result;
  }

  function mustRun(args) {
    const result = npmCli(args);

    if (result.status !== 0) {
      throw new Error(`npm ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }

    return result.stdout;
  }

  return {
    version: () => mustRun(["--version"]).trim(),
    published: (spec) => {
      const result = npmCli(["view", spec, "version", "--json"]);

      if (result.status === 0) {
        return result.stdout.trim() !== "";
      }

      const error = jsonError(result.stdout);

      if (error?.code === NOT_FOUND || result.stderr.includes(NOT_FOUND)) {
        return false;
      }

      const reason = error
        ? `${error.code} ${error.summary ?? ""}`.trim()
        : result.stderr.trim();

      throw new Error(`npm view ${spec} failed: ${reason}`.trim());
    },
    stagePublish: ({ dir, tag }) => {
      mustRun([
        "stage",
        "publish",
        dir,
        "--tag",
        tag,
        "--access",
        "public",
        "--loglevel",
        "notice",
      ]);
    },
    trust: ({ name, file, repository, environment }) => {
      const result = spawn(
        "npm",
        [
          "trust",
          "github",
          name,
          "--file",
          file,
          "--repo",
          repository,
          "--env",
          environment,
          "--allow-stage-publish",
          "--yes",
        ],
        { stdio: "inherit" },
      );

      if (result.error) {
        throw result.error;
      }

      if (result.status !== 0) {
        throw new Error(`npm trust github ${name} failed`);
      }
    },
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  };
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    env: process.env,
    npm: createNpm(spawnSync),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
