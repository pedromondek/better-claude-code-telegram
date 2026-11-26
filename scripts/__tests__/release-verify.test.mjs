import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { PACKAGE, REPOSITORY } from "../../npm/shim/shim.constants.mjs";
import { TARGETS, sha256Line } from "../release-binary.mjs";
import { platformOf } from "../release-npm.mjs";
import { recordHeadline } from "../release-publish.mjs";
import {
  extractedOutput,
  integrityOf,
  run,
  untar,
} from "../release-verify.mjs";
import {
  BUILD_WORKFLOW,
  NPM_REGISTRY,
  PROVENANCE_PREDICATE,
} from "../release.constants.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const VERSION = "0.2.0-beta.1";
const TAG = `v${VERSION}`;
const MERGE = "a".repeat(40);
const COMMIT = "b".repeat(40);
const NOTES = "<!-- notes -->\n### 📋 Summary\nThe notes.\n<!-- /notes -->";
const PLATFORMS = TARGETS.map(platformOf);
const BINARIES = Object.fromEntries(
  TARGETS.map(({ asset }) => [asset, `binary of ${asset}`]),
);
const hashOf = (text) => createHash("sha256").update(text).digest("hex");
const UNPACKED_SIZE = 4064168;
const MEBIBYTE = 1024 * 1024;
const CHECKSUMS = [
  "# version asset sha256",
  `0.1.0 bcct-linux-x64 ${"0".repeat(64)}`,
  ...TARGETS.map(
    ({ asset }) => `${VERSION} ${asset} ${hashOf(BINARIES[asset])}`,
  ),
  "",
].join("\n");
const SUMMARY = `✓ ${TAG}: the Release, its 6 binaries and the 7 npm packages match checksums.txt of bbbbbbb`;

function releaseAssets() {
  return {
    ...BINARIES,
    ...Object.fromEntries(
      TARGETS.map(({ asset }) => [
        `${asset}.sha256`,
        sha256Line(hashOf(BINARIES[asset]), asset),
      ]),
    ),
    "checksums.txt": CHECKSUMS,
  };
}

function packageFiles() {
  return {
    [PACKAGE]: {
      "package/checksums.txt": CHECKSUMS,
      "package/package.json": JSON.stringify({
        name: PACKAGE,
        version: VERSION,
        optionalDependencies: Object.fromEntries(
          PLATFORMS.map(({ packageName }) => [packageName, VERSION]),
        ),
      }),
    },
    ...Object.fromEntries(
      PLATFORMS.map(({ packageName, binary, asset }) => [
        packageName,
        { [`package/bin/${binary}`]: BINARIES[asset] },
      ]),
    ),
  };
}

function fakeGithub({
  pr = {},
  tagCommit = COMMIT,
  record = { parents: [MERGE], headline: recordHeadline(VERSION) },
  release = { isDraft: false, isImmutable: true, isPrerelease: true },
  assets = releaseAssets(),
  validRelease = () => true,
  validProvenance = () => true,
} = {}) {
  const calls = [];
  const github = {
    pullRequest: (number) => ({
      number,
      state: "MERGED",
      baseRefName: "main",
      headRefName: `release/${TAG}`,
      body: NOTES,
      mergeCommit: { oid: MERGE },
      ...pr,
    }),
    tagCommit: (tag) => {
      calls.push(["tagCommit", tag]);
      return tagCommit;
    },
    commit: (sha) => {
      calls.push(["commit", sha]);
      return record;
    },
    fileAt: (sha, path) => {
      calls.push(["fileAt", sha, path]);
      return CHECKSUMS;
    },
    release: (tag) => {
      calls.push(["release", tag]);
      return release === null
        ? null
        : {
            ...release,
            assets: Object.keys(assets).map((name) => ({ name })),
          };
    },
    download: (tag, dir) => {
      calls.push(["download", tag]);
      for (const [name, contents] of Object.entries(assets)) {
        writeFileSync(join(dir, name), contents);
      }
    },
    verifyReleaseAsset: (tag, file) => {
      calls.push(["verifyReleaseAsset", tag, basename(file)]);
      return validRelease(basename(file));
    },
    verifyAttestation: (file, identity) => {
      calls.push(["verifyAttestation", basename(file), identity]);
      return validProvenance(basename(file));
    },
  };

  return { github, calls };
}

function fakeRegistry({
  files = packageFiles(),
  missing = [],
  tags = { beta: VERSION, latest: "0.1.0" },
  manifest = (name, dist) => ({ name, version: VERSION, dist }),
  badIntegrity = [],
} = {}) {
  const tarballs = Object.fromEntries(
    Object.entries(files).map(([name, entries]) => [
      `https://registry.example/${name}.tgz`,
      Buffer.from(JSON.stringify(entries)),
    ]),
  );
  const requests = [];
  const registry = {
    manifest: async (name, version) => {
      requests.push(["manifest", name, version]);

      if (missing.includes(name) || version !== VERSION) {
        return null;
      }

      const tarball = `https://registry.example/${name}.tgz`;

      return manifest(name, {
        tarball,
        integrity: badIntegrity.includes(name)
          ? integrityOf(Buffer.from("other"))
          : integrityOf(tarballs[tarball]),
        unpackedSize: UNPACKED_SIZE,
        attestations: {
          url: `${NPM_REGISTRY}/-/npm/v1/attestations/${name}@${VERSION}`,
          provenance: { predicateType: PROVENANCE_PREDICATE },
        },
      });
    },
    distTags: async (name) => {
      requests.push(["distTags", name]);
      return tags;
    },
    tarball: async (url) => {
      requests.push(["tarball", url]);
      return tarballs[url];
    },
  };

  return { registry, requests };
}

function fakeTools({ audit = () => true } = {}) {
  const calls = [];
  const extractions = [];
  const tools = {
    untar: (bytes, path, maxBytes) => {
      extractions.push([path, maxBytes]);
      const entries = JSON.parse(bytes.toString("utf8"));

      return Object.hasOwn(entries, path) ? Buffer.from(entries[path]) : null;
    },
    auditSignatures: (install) => {
      calls.push(install);
      return audit(install);
    },
  };

  return { tools, calls, extractions };
}

async function verifyWith({
  args = [],
  env = {},
  github: githubOptions,
  registry: registryOptions,
  tools: toolsOptions,
} = {}) {
  const { github, calls } = fakeGithub(githubOptions);
  const { tools, calls: audits, extractions } = fakeTools(toolsOptions);
  const { registry, requests } = fakeRegistry(registryOptions);
  const out = [];
  const err = [];
  const code = await run(args, {
    env: { PR_NUMBER: "12", ...env },
    github,
    registry,
    tools,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return { code, out, err, calls, audits, requests, extractions };
}

describe("integrityOf", () => {
  it("writes the sha512 of the bytes in base64 after sha512-, as dist.integrity does", () => {
    expect(integrityOf(Buffer.from(""))).toBe(
      "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
    );
  });
});

function tarballOf(files) {
  const dir = mkdtempSync(join(tmpdir(), "bcct-untar-"));

  try {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), contents);
    }

    const packed = spawnSync("tar", ["-czf", "-", "-C", dir, "package"], {
      maxBuffer: 8 * MEBIBYTE,
    });

    if (packed.status !== 0) {
      throw new Error(`tar failed: ${packed.stderr}`);
    }

    return packed.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("untar", () => {
  const binary = randomBytes(2 * MEBIBYTE);
  const tarball = tarballOf({
    "package/bin/bcct": binary,
    "package/package.json": "{}",
  });

  it("extracts a file larger than 1 MiB up to the unpacked size of the package", () => {
    const extracted = untar(tarball, "package/bin/bcct", 3 * MEBIBYTE);

    expect(extracted?.equals(binary)).toBe(true);
  });

  it("returns null for a path the tarball does not have", () => {
    expect(untar(tarball, "package/bin/bcct.exe", 3 * MEBIBYTE)).toBeNull();
  });

  it("returns null when the file is larger than the size it may take", () => {
    expect(untar(tarball, "package/bin/bcct", MEBIBYTE)).toBeNull();
  });
});

describe("extractedOutput", () => {
  const stdout = Buffer.from("binary");
  const overflow = Object.assign(new Error("spawnSync tar ENOBUFS"), {
    code: "ENOBUFS",
  });

  it("returns the output of a tar that exited with 0 and no error", () => {
    expect(extractedOutput({ status: 0, stdout })).toBe(stdout);
  });

  it("returns null when the buffer overflowed even though tar exited with 0", () => {
    expect(extractedOutput({ status: 0, stdout, error: overflow })).toBeNull();
  });

  it("returns null when tar was killed or exited with another status", () => {
    expect(
      extractedOutput({ status: null, stdout, error: overflow }),
    ).toBeNull();
    expect(extractedOutput({ status: 2, stdout })).toBeNull();
  });
});

describe("release:verify › the record", () => {
  it("reads the checksums.txt of the tag commit, the record of the merged version pull request, and hands that commit to the next job", async () => {
    const outputFile = join(mkdtempSync(join(tmpdir(), "verify-")), "out");
    const { code, out, err, calls, requests } = await verifyWith({
      env: { GITHUB_OUTPUT: outputFile },
    });

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe(SUMMARY);
    expect(requests).toContainEqual(["distTags", PACKAGE]);
    expect(calls).toContainEqual(["tagCommit", TAG]);
    expect(calls).toContainEqual(["commit", COMMIT]);
    expect(calls).toContainEqual([
      "fileAt",
      COMMIT,
      "plugins/telegram-hooks/checksums.txt",
    ]);
    expect(readFileSync(outputFile, "utf8")).toBe(
      `commit=${COMMIT}\nversion=${VERSION}\n`,
    );
  });

  it.each([[[]], [["record"]], [["public"]]])(
    "finds the record of a pull request whose description lost its notes after the merge (%j)",
    async (args) => {
      const { code, err } = await verifyWith({
        args,
        github: { pr: { body: "The notes were moved to the Release." } },
      });

      expect(err).toEqual([]);
      expect(code).toBe(0);
    },
  );

  it("refuses a pull request that was not merged", async () => {
    const { code, err } = await verifyWith({
      github: { pr: { state: "OPEN", mergeCommit: null } },
    });

    expect(code).toBe(1);
    expect(err).toEqual(["✗ #12 was not merged"]);
  });

  it("refuses a version without its tag, since the Release was never published", async () => {
    const { code, err } = await verifyWith({ github: { tagCommit: null } });

    expect(code).toBe(1);
    expect(err).toEqual([`✗ ${TAG} has no tag`]);
  });

  it.each([
    [
      "another parent",
      { parents: ["c".repeat(40)], headline: recordHeadline(VERSION) },
    ],
    [
      "two parents",
      { parents: [MERGE, "c".repeat(40)], headline: recordHeadline(VERSION) },
    ],
    [
      "another headline",
      { parents: [MERGE], headline: recordHeadline("0.2.0-beta.2") },
    ],
  ])(
    "refuses a tag whose commit is not the record of the merge (%s)",
    async (_case, record) => {
      const { code, err } = await verifyWith({ github: { record } });

      expect(code).toBe(1);
      expect(err).toEqual([
        `✗ ${TAG} points at bbbbbbb, which is not the record of the merge aaaaaaa`,
      ]);
    },
  );
});

describe("release:verify › the Release", () => {
  it("checks each binary against the attestation of the Release and the build provenance signed by build-binaries.yml on a GitHub-hosted runner", async () => {
    const { calls } = await verifyWith();

    expect(calls.filter(([name]) => name === "verifyReleaseAsset")).toEqual(
      TARGETS.map(({ asset }) => ["verifyReleaseAsset", TAG, asset]),
    );
    expect(calls.filter(([name]) => name === "verifyAttestation")).toEqual(
      TARGETS.map(({ asset }) => [
        "verifyAttestation",
        asset,
        {
          repository: REPOSITORY,
          signerWorkflow: `${REPOSITORY}/.github/workflows/${BUILD_WORKFLOW}`,
        },
      ]),
    );
  });

  it("reports a version without a Release, and still checks npm", async () => {
    const { code, err } = await verifyWith({
      github: { release: null },
      registry: { missing: [PACKAGE] },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ ${TAG} has no Release`,
      `✗ ${PACKAGE}@${VERSION} is not on npm: approve the 7 staged packages on npmjs.com, then re-run the failed jobs`,
    ]);
  });

  it("reports a draft, a mutable Release and the wrong pre-release mark all at once", async () => {
    const { code, err } = await verifyWith({
      github: {
        release: { isDraft: true, isImmutable: false, isPrerelease: false },
      },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ the Release ${TAG} is still a draft`,
      `✗ the Release ${TAG} is not immutable`,
      `✗ the Release ${TAG} is not marked as a pre-release`,
    ]);
  });

  it("wants a stable version off the pre-releases", async () => {
    const { err } = await verifyWith({
      github: {
        pr: { headRefName: "release/v0.2.0" },
        record: { parents: [MERGE], headline: recordHeadline("0.2.0") },
        release: { isDraft: false, isImmutable: true, isPrerelease: true },
      },
    });

    expect(err).toContain("✗ the Release v0.2.0 is marked as a pre-release");
  });

  it("names the assets that are missing from the Release and the ones it should not have", async () => {
    const { "bcct-linux-x64.sha256": _gone, ...rest } = releaseAssets();
    const { code, err } = await verifyWith({
      github: { assets: { ...rest, "notes.md": "x" } },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ the Release ${TAG} lacks bcct-linux-x64.sha256 and has notes.md, which it should not`,
      `✗ bcct-linux-x64.sha256 is missing from the Release ${TAG}`,
    ]);
  });

  it("reports a binary, a sha256 file and a checksums.txt of the Release that differ from the record", async () => {
    const { code, err } = await verifyWith({
      github: {
        assets: {
          ...releaseAssets(),
          "bcct-darwin-arm64": "another build",
          "bcct-win32-x64.exe.sha256": sha256Line(
            "0".repeat(64),
            "bcct-win32-x64.exe",
          ),
          "checksums.txt": "# version asset sha256\n",
        },
      },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      "✗ bcct-darwin-arm64 on the Release does not match checksums.txt of bbbbbbb",
      "✗ bcct-win32-x64.exe.sha256 on the Release does not match checksums.txt of bbbbbbb",
      "✗ checksums.txt on the Release is not the one of bbbbbbb",
    ]);
  });

  it("reports a binary without the attestation of the Release or without the build provenance", async () => {
    const { code, err } = await verifyWith({
      github: {
        validRelease: (asset) => asset !== "bcct-linux-arm64",
        validProvenance: (asset) => asset !== "bcct-win32-arm64.exe",
      },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ bcct-linux-arm64 has no valid attestation of the Release ${TAG}`,
      `✗ bcct-win32-arm64.exe has no valid build provenance from ${BUILD_WORKFLOW}`,
    ]);
  });
});

describe("release:verify › npm", () => {
  it("audits the registry signatures and the provenance of the package installed for each of the 6 platforms, without its scripts", async () => {
    const { audits } = await verifyWith();

    expect(audits).toEqual(
      PLATFORMS.map(({ os, cpu }) => ({
        spec: `${PACKAGE}@${VERSION}`,
        os,
        cpu,
      })),
    );
  });

  it("says to approve the staged packages when a package is not on npm yet, without checking it further", async () => {
    const name = PLATFORMS[0].packageName;
    const { code, err, audits } = await verifyWith({
      registry: { missing: [name] },
      tools: { audit: () => false },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ ${name}@${VERSION} is not on npm: approve the 7 staged packages on npmjs.com, then re-run the failed jobs`,
    ]);
    expect(audits).toEqual([]);
  });

  it.each([
    [{ beta: "0.2.0-beta.0" }, "0.2.0-beta.0"],
    [{ latest: VERSION }, "unset"],
  ])(
    "reports the dist-tag of the stage when it does not point at the version (%j)",
    async (tags, found) => {
      const { err } = await verifyWith({ registry: { tags } });

      expect(err).toHaveLength(7);
      expect(err[0]).toBe(
        `✗ the beta tag of ${PLATFORMS[0].packageName} is ${found}, not ${VERSION}`,
      );
    },
  );

  it("reports a tarball that does not match dist.integrity", async () => {
    const { err } = await verifyWith({ registry: { badIntegrity: [PACKAGE] } });

    expect(err).toEqual([
      `✗ the tarball of ${PACKAGE}@${VERSION} does not match its dist.integrity`,
    ]);
  });

  it("reports a package without the provenance of trusted publishing", async () => {
    const name = PLATFORMS[2].packageName;
    const { err } = await verifyWith({
      registry: {
        manifest: (packageName, dist) => ({
          dist:
            packageName === name ? { ...dist, attestations: undefined } : dist,
        }),
      },
    });

    expect(err).toEqual([
      `✗ ${name}@${VERSION} has no ${PROVENANCE_PREDICATE} provenance`,
    ]);
  });

  it("extracts each file of a package up to the dist.unpackedSize of its manifest", async () => {
    const { extractions } = await verifyWith();

    expect(extractions).toEqual(
      expect.arrayContaining([
        ["package/checksums.txt", UNPACKED_SIZE],
        ["package/package.json", UNPACKED_SIZE],
        ...PLATFORMS.map(({ binary }) => [
          `package/bin/${binary}`,
          UNPACKED_SIZE,
        ]),
      ]),
    );
    expect(extractions).toHaveLength(2 + PLATFORMS.length);
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["text", String(UNPACKED_SIZE)],
  ])(
    "reports a package whose dist.unpackedSize is %s, without reading its files",
    async (_, unpackedSize) => {
      const name = PLATFORMS[1].packageName;
      const { err, extractions } = await verifyWith({
        registry: {
          manifest: (packageName, dist) => ({
            dist: packageName === name ? { ...dist, unpackedSize } : dist,
          }),
        },
      });

      expect(err).toEqual([`✗ ${name}@${VERSION} has no dist.unpackedSize`]);
      expect(extractions).toHaveLength(1 + PLATFORMS.length);
    },
  );

  it("reports a platform package whose binary differs from the record, or that has no binary", async () => {
    const [first, second] = PLATFORMS;
    const files = packageFiles();

    files[first.packageName] = { [`package/bin/${first.binary}`]: "other" };
    files[second.packageName] = {};

    const { err } = await verifyWith({ registry: { files } });

    expect(err).toEqual([
      `✗ the binary in ${first.packageName}@${VERSION} does not match checksums.txt of bbbbbbb`,
      `✗ the binary in ${second.packageName}@${VERSION} does not match checksums.txt of bbbbbbb`,
    ]);
  });

  it("reports a main package whose checksums.txt or platform dependencies differ", async () => {
    const files = packageFiles();

    files[PACKAGE] = {
      "package/checksums.txt": "# version asset sha256\n",
      "package/package.json": JSON.stringify({
        optionalDependencies: { [PLATFORMS[0].packageName]: "0.2.0-beta.0" },
      }),
    };

    const { err } = await verifyWith({ registry: { files } });

    expect(err).toEqual([
      `✗ checksums.txt in ${PACKAGE}@${VERSION} is not the one of bbbbbbb`,
      `✗ ${PACKAGE}@${VERSION} does not depend on the 6 platform packages at ${VERSION}`,
    ]);
  });

  it("reports a main package without checksums.txt or package.json", async () => {
    const files = packageFiles();

    files[PACKAGE] = {};

    const { err } = await verifyWith({ registry: { files } });

    expect(err).toEqual([
      `✗ checksums.txt in ${PACKAGE}@${VERSION} is not the one of bbbbbbb`,
      `✗ ${PACKAGE}@${VERSION} does not depend on the 6 platform packages at ${VERSION}`,
    ]);
  });

  it("reports the platform whose npm audit signatures fails", async () => {
    const { code, err } = await verifyWith({
      tools: { audit: ({ os, cpu }) => !(os === "darwin" && cpu === "x64") },
    });

    expect(code).toBe(1);
    expect(err).toEqual(["✗ npm audit signatures failed on darwin x64"]);
  });
});

describe("release:verify › record", () => {
  it("hands the version and its record commit to the next job without reading the Release or npm", async () => {
    const outputFile = join(mkdtempSync(join(tmpdir(), "verify-")), "out");
    const { code, out, err, calls, audits, requests } = await verifyWith({
      args: ["record"],
      env: { GITHUB_OUTPUT: outputFile },
    });

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out).toEqual([`✓ ${TAG} is recorded in bbbbbbb`]);
    expect(calls).toEqual([
      ["tagCommit", TAG],
      ["commit", COMMIT],
    ]);
    expect(audits).toEqual([]);
    expect(requests).toEqual([]);
    expect(readFileSync(outputFile, "utf8")).toBe(
      `commit=${COMMIT}\nversion=${VERSION}\n`,
    );
  });

  it("refuses a tag whose commit is not the record of the merge", async () => {
    const { code, err, out } = await verifyWith({
      args: ["record"],
      github: { record: { parents: [MERGE], headline: "other" } },
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `✗ ${TAG} points at bbbbbbb, which is not the record of the merge aaaaaaa`,
    ]);
  });
});

describe("release:verify › public", () => {
  const allPackages = [
    ...PLATFORMS.map(({ packageName }) => packageName),
    PACKAGE,
  ];

  it("passes when npm serves the version of all 7 packages, reading only their manifests", async () => {
    const outputFile = join(mkdtempSync(join(tmpdir(), "verify-")), "out");
    const { code, out, err, requests, audits } = await verifyWith({
      args: ["public"],
      env: { GITHUB_OUTPUT: outputFile },
    });

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out).toEqual([`✓ ${TAG}: npm serves the 7 packages`]);
    expect(requests).toEqual(
      allPackages.map((name) => ["manifest", name, VERSION]),
    );
    expect(audits).toEqual([]);
    expect(existsSync(outputFile)).toBe(false);
  });

  it("fails naming each package npm does not serve yet, as while they wait for the approval", async () => {
    const [first, second] = PLATFORMS.map(({ packageName }) => packageName);
    const { code, out, err } = await verifyWith({
      args: ["public"],
      registry: { missing: [first, second] },
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `✗ ${first}@${VERSION} is not on npm: approve the 7 staged packages on npmjs.com before announcing`,
      `✗ ${second}@${VERSION} is not on npm: approve the 7 staged packages on npmjs.com before announcing`,
    ]);
  });

  it("refuses a pull request whose tag is not the record of the merge", async () => {
    const { code, err } = await verifyWith({
      args: ["public"],
      github: { record: { parents: [MERGE], headline: "other" } },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ ${TAG} points at bbbbbbb, which is not the record of the merge aaaaaaa`,
    ]);
  });
});

describe("release:verify › run", () => {
  it.each([[["x"]], [["--fix"]], [["record", "x"]], [["public", "x"]]])(
    "a usage error exits 2 (%j)",
    async (args) => {
      expect(await verifyWith({ args })).toMatchObject({
        code: 2,
        err: [
          "usage: npm run release:verify [-- record | public] (pull request in PR_NUMBER)",
        ],
      });
    },
  );

  it("is the release:verify npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["release:verify"]).toBe("node scripts/release-verify.mjs");
  });

  it("reads the registry that the release job publishes to", () => {
    const release = parse(
      readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"),
    );
    const setupNode = release.jobs.npm.steps.find((step) =>
      (step.uses ?? "").startsWith("actions/setup-node@"),
    );

    expect(setupNode.with["registry-url"]).toBe(NPM_REGISTRY);
  });

  it("signs with the build workflow that exists", () => {
    expect(
      readFileSync(join(ROOT, ".github/workflows", BUILD_WORKFLOW), "utf8"),
    ).toContain("actions/attest@");
  });
});
