import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectedHash } from "../npm/shim/shim.mjs";
import { PACKAGE, REPOSITORY } from "../npm/shim/shim.constants.mjs";
import { TARGETS, sha256Line } from "./release-binary.mjs";
import { distTagOf } from "./release-npm-publish.mjs";
import { platformOf } from "./release-npm.mjs";
import { CHECKSUMS_FILE } from "./release-order.mjs";
import {
  RELEASE_ASSETS,
  githubCli,
  mergedReleaseRef,
  output,
  recordHeadline,
  short,
} from "./release-publish.mjs";
import {
  BUILD_WORKFLOW,
  NPM_REGISTRY,
  PROVENANCE_PREDICATE,
} from "./release.constants.mjs";
import { parseVersion } from "./version.mjs";

const USAGE =
  "usage: npm run release:verify [-- record | public] (pull request in PR_NUMBER)";
const PLATFORMS = TARGETS.map(platformOf);
const NPM_PACKAGES = [
  ...PLATFORMS.map(({ packageName }) => packageName),
  PACKAGE,
];
const SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/${BUILD_WORKFLOW}`;

export function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function recordOf(github, number) {
  const { version, merge } = mergedReleaseRef(github.pullRequest(number));
  const tag = `v${version}`;
  const commit = github.tagCommit(tag);

  if (commit === null) {
    throw new Error(`${tag} has no tag`);
  }

  const { parents, headline } = github.commit(commit);

  if (
    parents.length !== 1 ||
    parents[0] !== merge ||
    headline !== recordHeadline(version)
  ) {
    throw new Error(
      `${tag} points at ${short(commit)}, which is not the record of the merge ${short(merge)}`,
    );
  }

  return { version, tag, commit };
}

function assetProblem(tag, names) {
  const missing = RELEASE_ASSETS.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !RELEASE_ASSETS.includes(name));
  const parts = [
    ...(missing.length > 0 ? [`lacks ${missing.join(", ")}`] : []),
    ...(extra.length > 0
      ? [`has ${extra.join(", ")}, which it should not`]
      : []),
  ];

  return parts.length > 0 ? [`the Release ${tag} ${parts.join(" and ")}`] : [];
}

function releaseMarks(found, { tag, version }) {
  const prerelease = parseVersion(version).stage !== null;

  return [
    ...(found.isDraft ? [`the Release ${tag} is still a draft`] : []),
    ...(found.isImmutable ? [] : [`the Release ${tag} is not immutable`]),
    ...(found.isPrerelease === prerelease
      ? []
      : [
          `the Release ${tag} is ${prerelease ? "not marked" : "marked"} as a pre-release`,
        ]),
  ];
}

function downloadedHashes(dir, { tag, version, commit, checksums }) {
  const problems = [];
  const read = (name) => {
    const path = join(dir, name);

    if (!existsSync(path)) {
      problems.push(`${name} is missing from the Release ${tag}`);
      return null;
    }

    return readFileSync(path);
  };

  for (const { asset } of TARGETS) {
    const expected = expectedHash(checksums, version, asset);
    const binary = read(asset);
    const line = read(`${asset}.sha256`);

    if (binary !== null && sha256Of(binary) !== expected) {
      problems.push(
        `${asset} on the Release does not match checksums.txt of ${short(commit)}`,
      );
    }

    if (
      line !== null &&
      line.toString("utf8") !== sha256Line(expected, asset)
    ) {
      problems.push(
        `${asset}.sha256 on the Release does not match checksums.txt of ${short(commit)}`,
      );
    }
  }

  const ledger = read("checksums.txt");

  if (ledger !== null && ledger.toString("utf8") !== checksums) {
    problems.push(
      `checksums.txt on the Release is not the one of ${short(commit)}`,
    );
  }

  return problems;
}

function attestationProblems(github, dir, tag) {
  return TARGETS.filter(({ asset }) => existsSync(join(dir, asset))).flatMap(
    ({ asset }) => {
      const file = join(dir, asset);

      return [
        ...(github.verifyReleaseAsset(tag, file)
          ? []
          : [`${asset} has no valid attestation of the Release ${tag}`]),
        ...(github.verifyAttestation(file, {
          repository: REPOSITORY,
          signerWorkflow: SIGNER_WORKFLOW,
        })
          ? []
          : [`${asset} has no valid build provenance from ${BUILD_WORKFLOW}`]),
      ];
    },
  );
}

function releaseProblems(github, record) {
  const found = github.release(record.tag);

  if (found === null) {
    return [`${record.tag} has no Release`];
  }

  const dir = mkdtempSync(join(tmpdir(), "bcct-verify-"));

  try {
    github.download(record.tag, dir);

    return [
      ...releaseMarks(found, record),
      ...assetProblem(
        record.tag,
        found.assets.map(({ name }) => name),
      ),
      ...downloadedHashes(dir, record),
      ...attestationProblems(github, dir, record.tag),
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function contentProblems(name, files, { version, commit, checksums }) {
  const spec = `${name}@${version}`;

  if (name !== PACKAGE) {
    const platform = PLATFORMS.find(({ packageName }) => packageName === name);
    const binary = files(`package/bin/${platform.binary}`);

    return binary !== null &&
      sha256Of(binary) === expectedHash(checksums, version, platform.asset)
      ? []
      : [
          `the binary in ${spec} does not match checksums.txt of ${short(commit)}`,
        ];
  }

  const ledger = files("package/checksums.txt");
  const manifest = files("package/package.json");
  const dependencies =
    manifest === null
      ? {}
      : (JSON.parse(manifest.toString("utf8")).optionalDependencies ?? {});
  const expected = Object.fromEntries(
    PLATFORMS.map(({ packageName }) => [packageName, version]),
  );

  return [
    ...(ledger !== null && ledger.toString("utf8") === checksums
      ? []
      : [`checksums.txt in ${spec} is not the one of ${short(commit)}`]),
    ...(JSON.stringify(Object.entries(dependencies).toSorted()) ===
    JSON.stringify(Object.entries(expected).toSorted())
      ? []
      : [`${spec} does not depend on the 6 platform packages at ${version}`]),
  ];
}

async function packageProblems({ registry, tools }, name, record) {
  const { version } = record;
  const spec = `${name}@${version}`;
  const manifest = await registry.manifest(name, version);

  if (manifest === null) {
    return {
      published: false,
      problems: [
        `${spec} is not on npm: approve the 7 staged packages on npmjs.com, then re-run the failed jobs`,
      ],
    };
  }

  const tag = distTagOf(version);
  const tagged = (await registry.distTags(name))[tag];
  const tarball = await registry.tarball(manifest.dist.tarball);
  const integral = integrityOf(tarball) === manifest.dist.integrity;
  const { unpackedSize } = manifest.dist;
  const sized = Number.isSafeInteger(unpackedSize) && unpackedSize > 0;

  return {
    published: true,
    problems: [
      ...(tagged === version
        ? []
        : [
            `the ${tag} tag of ${name} is ${tagged ?? "unset"}, not ${version}`,
          ]),
      ...(integral
        ? []
        : [`the tarball of ${spec} does not match its dist.integrity`]),
      ...(manifest.dist.attestations?.provenance?.predicateType ===
      PROVENANCE_PREDICATE
        ? []
        : [`${spec} has no ${PROVENANCE_PREDICATE} provenance`]),
      ...(sized ? [] : [`${spec} has no dist.unpackedSize`]),
      ...(integral && sized
        ? contentProblems(
            name,
            (path) => tools.untar(tarball, path, unpackedSize),
            record,
          )
        : []),
    ],
  };
}

async function npmProblems(deps, record) {
  const problems = [];
  let allPublished = true;

  for (const name of NPM_PACKAGES) {
    const found = await packageProblems(deps, name, record);

    allPublished &&= found.published;
    problems.push(...found.problems);
  }

  if (!allPublished) {
    return problems;
  }

  for (const { os, cpu } of PLATFORMS) {
    if (
      !deps.tools.auditSignatures({
        spec: `${PACKAGE}@${record.version}`,
        os,
        cpu,
      })
    ) {
      problems.push(`npm audit signatures failed on ${os} ${cpu}`);
    }
  }

  return problems;
}

async function verify({ env, github, registry, tools, out }) {
  const { version, tag, commit } = recordOf(github, Number(env.PR_NUMBER));
  const record = {
    version,
    tag,
    commit,
    checksums: github.fileAt(commit, CHECKSUMS_FILE),
  };
  const problems = [
    ...releaseProblems(github, record),
    ...(await npmProblems({ registry, tools }, record)),
  ];

  if (problems.length > 0) {
    return problems;
  }

  output(env, { commit, version });
  out(
    `✓ ${tag}: the Release, its 6 binaries and the 7 npm packages match checksums.txt of ${short(commit)}`,
  );

  return [];
}

function recordOnly({ env, github, out }) {
  const { version, tag, commit } = recordOf(github, Number(env.PR_NUMBER));

  output(env, { commit, version });
  out(`✓ ${tag} is recorded in ${short(commit)}`);

  return [];
}

async function publicOnly({ env, github, registry, out }) {
  const { version, tag } = recordOf(github, Number(env.PR_NUMBER));
  const problems = [];

  for (const name of NPM_PACKAGES) {
    if ((await registry.manifest(name, version)) === null) {
      problems.push(
        `${name}@${version} is not on npm: approve the 7 staged packages on npmjs.com before announcing`,
      );
    }
  }

  if (problems.length === 0) {
    out(`✓ ${tag}: npm serves the 7 packages`);
  }

  return problems;
}

export async function run(args, { env, github, registry, tools, out, err }) {
  const action =
    args.length === 0
      ? verify
      : args.length === 1 && args[0] === "record"
        ? recordOnly
        : args.length === 1 && args[0] === "public"
          ? publicOnly
          : null;

  if (action === null) {
    err(USAGE);
    return 2;
  }

  try {
    const problems = await action({ env, github, registry, tools, out });

    for (const problem of problems) {
      err(`✗ ${problem}`);
    }

    return problems.length > 0 ? 1 : 0;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function ghStatus(args) {
  return spawnSync("gh", args, { stdio: ["ignore", "inherit", "inherit"] })
    .status;
}

function ghRead(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function tagObject(path) {
  const result = ghRead(["api", path]);

  if (result.status === 0) {
    return JSON.parse(result.stdout).object;
  }

  if (result.stdout.includes('"Not Found"')) {
    return null;
  }

  throw new Error(`gh api ${path} failed: ${result.stderr.trim()}`);
}

const github = {
  ...githubCli,
  tagCommit: (tag) => {
    const found = tagObject(`repos/{owner}/{repo}/git/ref/tags/${tag}`);

    if (found === null || found.type === "commit") {
      return found?.sha ?? null;
    }

    return tagObject(`repos/{owner}/{repo}/git/tags/${found.sha}`).sha;
  },
  release: (tag) => {
    const result = ghRead([
      "release",
      "view",
      tag,
      "--json",
      "isDraft,isImmutable,isPrerelease,assets",
    ]);

    if (result.status === 0) {
      return JSON.parse(result.stdout);
    }

    if (result.stderr.includes("release not found")) {
      return null;
    }

    throw new Error(`gh release view ${tag} failed: ${result.stderr.trim()}`);
  },
  download: (tag, dir) => {
    if (ghStatus(["release", "download", tag, "--dir", dir]) !== 0) {
      throw new Error(`gh release download ${tag} failed`);
    }
  },
  verifyReleaseAsset: (tag, file) =>
    ghStatus(["release", "verify-asset", tag, file]) === 0,
  verifyAttestation: (file, { repository, signerWorkflow }) =>
    ghStatus([
      "attestation",
      "verify",
      file,
      "--repo",
      repository,
      "--signer-workflow",
      signerWorkflow,
      "--deny-self-hosted-runners",
    ]) === 0,
};

async function fetchOk(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`npm answered ${response.status} for ${url}`);
  }

  return response;
}

const registry = {
  manifest: async (name, version) => {
    const response = await fetch(`${NPM_REGISTRY}/${name}/${version}`);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`npm answered ${response.status} for ${name}@${version}`);
    }

    return response.json();
  },
  distTags: async (name) =>
    (await fetchOk(`${NPM_REGISTRY}/-/package/${name}/dist-tags`)).json(),
  tarball: async (url) => Buffer.from(await (await fetchOk(url)).arrayBuffer()),
};

function npmIn(dir, args) {
  return (
    spawnSync("npm", args, {
      cwd: dir,
      stdio: ["ignore", "inherit", "inherit"],
    }).status === 0
  );
}

export function extractedOutput(result) {
  return result.error === undefined && result.status === 0
    ? result.stdout
    : null;
}

export function untar(bytes, path, maxBytes) {
  return extractedOutput(
    spawnSync("tar", ["-xzO", "-f", "-", path], {
      input: bytes,
      maxBuffer: maxBytes,
    }),
  );
}

const tools = {
  untar,
  auditSignatures: ({ spec, os, cpu }) => {
    const dir = mkdtempSync(join(tmpdir(), "bcct-audit-"));

    try {
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify({ name: "bcct-audit", private: true })}\n`,
      );

      return (
        npmIn(dir, [
          "install",
          spec,
          `--os=${os}`,
          `--cpu=${cpu}`,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ]) && npmIn(dir, ["audit", "signatures"])
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    github,
    registry,
    tools,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
