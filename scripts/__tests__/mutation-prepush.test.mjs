import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectTargets,
  fitsProgressBar,
  isMutationTarget,
  restrictTargets,
  shouldForceMutation,
  specToSource,
  STRYKER_PROGRESS_BAR_MIN_COLUMNS,
  strykerArgs,
  survivorsIn,
  toLayerChangedLines,
} from "../mutation-prepush.mjs";

const hasUtilLinuxScript =
  spawnSync("script", ["--version"], { encoding: "utf8" }).stdout?.includes(
    "util-linux",
  ) ?? false;

const SOURCE = [
  "class Svc {",
  "  method() {",
  "    this.logger.log('lifecycle', { count: n });",
  "    this.logger.error(",
  "      `Error ${id}`,",
  "    );",
  "    const url = 'https://api.example.com';",
  "    if (id > 0) {",
  "      return url;",
  "    }",
  "    this.logger.warn('end');",
  "    const label = 'x';",
  "  }",
  "}",
].join("\n");

const EXT = "plugins/telegram/extensions";
const EXT_MUTATE = [`${EXT}/**/*.ts`, `!${EXT}/**/__tests__/**`];

const mutant = (mutatorName, line, coveredBy = ["t1"]) => ({
  mutatorName,
  status: "Survived",
  location: { start: { line } },
  coveredBy,
});

const existing = (...paths) => {
  const set = new Set(paths);
  return (path) => set.has(path);
};

describe("survivorsIn › log filter", () => {
  const buildReport = () => ({
    files: {
      "src/svc.ts": {
        source: SOURCE,
        mutants: [
          mutant("StringLiteral", 3),
          mutant("ConditionalExpression", 8),
        ],
      },
    },
    testFiles: {
      "src/modules/svc/__tests__/svc.service.spec.ts": {
        tests: [{ id: "t1" }],
      },
    },
  });

  it("spec in the push: a log StringLiteral goes to ignoredLogs and the behavior branch blocks", () => {
    const specSources = new Map([
      [
        "src/svc.ts",
        new Set(["src/modules/svc/__tests__/svc.service.spec.ts"]),
      ],
    ]);

    const { offenders, ignoredLogs } = survivorsIn(
      buildReport(),
      new Set(),
      specSources,
    );

    expect(ignoredLogs).toHaveLength(1);
    expect(ignoredLogs[0]).toMatch(/src\/svc\.ts:3/);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/src\/svc\.ts:8 ConditionalExpression/);
  });

  it("source in the push: the same filter, without depending on coveredBy", () => {
    const { offenders, ignoredLogs } = survivorsIn(
      buildReport(),
      new Set(["src/svc.ts"]),
      new Map(),
    );

    expect(ignoredLogs).toHaveLength(1);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/src\/svc\.ts:8/);
  });

  it("a survivor outside the coveredBy of the push spec does not block", () => {
    const report = buildReport();
    report.files["src/svc.ts"].mutants = [
      mutant("ConditionalExpression", 8, ["t-other"]),
    ];
    const specSources = new Map([
      [
        "src/svc.ts",
        new Set(["src/modules/svc/__tests__/svc.service.spec.ts"]),
      ],
    ]);

    const { offenders } = survivorsIn(report, new Set(), specSources);

    expect(offenders).toEqual([]);
  });
});

describe("survivorsIn › survivor with no test run", () => {
  const reportWith = (...mutants) => ({
    files: { "src/svc.ts": { source: SOURCE, mutants } },
    testFiles: {},
  });

  it("blocks as unmeasured the Survived that completed zero tests", () => {
    const { offenders } = survivorsIn(
      reportWith({ ...mutant("ConditionalExpression", 8), testsCompleted: 0 }),
      new Set(["src/svc.ts"]),
      new Map(),
    );

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/src\/svc\.ts:8 ConditionalExpression/);
    expect(offenders[0]).toMatch(/unmeasured/);
  });

  it("does not mark as unmeasured the Survived that ran tests", () => {
    const { offenders } = survivorsIn(
      reportWith({ ...mutant("ConditionalExpression", 8), testsCompleted: 3 }),
      new Set(["src/svc.ts"]),
      new Map(),
    );

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).not.toMatch(/unmeasured/);
  });

  it("does not let the log filter hide the mutant that was not measured", () => {
    const { offenders, ignoredLogs } = survivorsIn(
      reportWith({ ...mutant("StringLiteral", 3), testsCompleted: 0 }),
      new Set(["src/svc.ts"]),
      new Map(),
    );

    expect(ignoredLogs).toEqual([]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/src\/svc\.ts:3 StringLiteral/);
    expect(offenders[0]).toMatch(/unmeasured/);
  });
});

describe("survivorsIn › baseline and changed lines", () => {
  const reportWith = (...mutants) => ({
    files: { "src/svc.ts": { source: SOURCE, mutants } },
    testFiles: {
      "src/__tests__/svc.test.ts": { tests: [{ id: "t1" }] },
    },
  });
  const direct = new Set(["src/svc.ts"]);

  it("blocks the survivor on a line changed in the push even with a baseline that covers it", () => {
    const { offenders } = survivorsIn(
      reportWith(mutant("ConditionalExpression", 8)),
      direct,
      new Map(),
      {
        baseline: { "src/svc.ts": { ConditionalExpression: 1 } },
        changedLines: new Map([["src/svc.ts", new Set([8])]]),
      },
    );

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/src\/svc\.ts:8 ConditionalExpression/);
    expect(offenders[0]).toMatch(/line changed/);
  });

  it("does not block the survivor outside the changed lines that the file's baseline already records", () => {
    const { offenders, improvements } = survivorsIn(
      reportWith(mutant("ConditionalExpression", 8)),
      direct,
      new Map(),
      {
        baseline: { "src/svc.ts": { ConditionalExpression: 1 } },
        changedLines: new Map([["src/svc.ts", new Set([12])]]),
      },
    );

    expect(offenders).toEqual([]);
    expect(improvements).toEqual([]);
  });

  it("blocks all the survivors of the mutator when they exceed the file's baseline", () => {
    const { offenders } = survivorsIn(
      reportWith(
        mutant("ConditionalExpression", 8),
        mutant("ConditionalExpression", 9),
      ),
      direct,
      new Map(),
      { baseline: { "src/svc.ts": { ConditionalExpression: 1 } } },
    );

    expect(offenders).toHaveLength(2);
    expect(offenders[0]).toMatch(/src\/svc\.ts:8 ConditionalExpression/);
    expect(offenders[1]).toMatch(/src\/svc\.ts:9 ConditionalExpression/);
    expect(offenders[0]).toMatch(/above baseline: 2 alive, baseline 1/);
  });

  it("blocks the survivor of a mutator that the file's baseline does not record", () => {
    const { offenders } = survivorsIn(
      reportWith(mutant("EqualityOperator", 8)),
      direct,
      new Map(),
      { baseline: { "src/svc.ts": { ConditionalExpression: 1 } } },
    );

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/EqualityOperator/);
    expect(offenders[0]).toMatch(/baseline 0/);
  });

  it("points out as an improvement the mutator with fewer survivors than the baseline, including the one that reached zero", () => {
    const { offenders, improvements } = survivorsIn(
      reportWith(mutant("ConditionalExpression", 8)),
      direct,
      new Map(),
      {
        baseline: {
          "src/svc.ts": { ConditionalExpression: 3, StringLiteral: 2 },
        },
      },
    );

    expect(offenders).toEqual([]);
    expect(improvements).toEqual([
      "src/svc.ts ConditionalExpression: 1 alive, baseline 3",
      "src/svc.ts StringLiteral: 0 alive, baseline 2",
    ]);
  });

  it("spec in the push: counts against the baseline only the survivors covered by the spec", () => {
    const { offenders } = survivorsIn(
      reportWith(
        mutant("ConditionalExpression", 8),
        mutant("ConditionalExpression", 9, ["t-other"]),
      ),
      new Set(),
      new Map([["src/svc.ts", new Set(["src/__tests__/svc.test.ts"])]]),
      { baseline: { "src/svc.ts": { ConditionalExpression: 1 } } },
    );

    expect(offenders).toEqual([]);
  });

  it("blocks the unmeasured survivor even with a baseline that covers the mutator", () => {
    const { offenders } = survivorsIn(
      reportWith({ ...mutant("ConditionalExpression", 8), testsCompleted: 0 }),
      direct,
      new Map(),
      { baseline: { "src/svc.ts": { ConditionalExpression: 5 } } },
    );

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatch(/unmeasured/);
  });
});

describe("toLayerChangedLines", () => {
  it("keeps the changed lines of the layer relative to it and drops the ones from outside it", () => {
    const changed = toLayerChangedLines(
      new Map([
        ["packages/app/src/a.tsx", new Set([3, 4])],
        ["packages/lib/src/b.ts", new Set([1])],
        ["scripts/x.mjs", new Set([9])],
      ]),
      "packages/app",
    );

    expect([...changed.keys()]).toEqual(["src/a.tsx"]);
    expect([...changed.get("src/a.tsx")]).toEqual([3, 4]);
  });

  it("with the repository root as the layer, keeps every path as it is", () => {
    const changed = toLayerChangedLines(
      new Map([
        [`${EXT}/config.ts`, new Set([3, 4])],
        ["scripts/x.mjs", new Set([9])],
      ]),
      "",
    );

    expect([...changed.keys()]).toEqual([`${EXT}/config.ts`, "scripts/x.mjs"]);
    expect([...changed.get(`${EXT}/config.ts`)]).toEqual([3, 4]);
  });
});

describe("strykerArgs", () => {
  it("mutates only the push files, writes the JSON report, shows the progress in lines and only Stryker's warning and error", () => {
    expect(strykerArgs(new Set(["src/a.ts", "src/b.tsx"]))).toEqual([
      "run",
      "--mutate",
      "src/a.ts,src/b.tsx",
      "--reporters",
      "json,progress-append-only",
      "--logLevel",
      "warn",
    ]);
  });

  it("shows the progress in a bar that updates in place when the push runs in a terminal", () => {
    expect(strykerArgs(new Set(["src/a.ts"]), { interactive: true })).toEqual([
      "run",
      "--mutate",
      "src/a.ts",
      "--reporters",
      "json,progress",
      "--logLevel",
      "warn",
    ]);
  });

  it("redoes every mutant with --force when requested (MUTATION_FORCE=1 in CI)", () => {
    expect(strykerArgs(new Set(["src/a.ts"]), { force: true })).toEqual([
      "run",
      "--mutate",
      "src/a.ts",
      "--reporters",
      "json,progress-append-only",
      "--logLevel",
      "warn",
      "--force",
    ]);
  });
});

describe("shouldForceMutation", () => {
  const files = (...paths) => paths;

  it("does not force in the pre-push, not even with a support file, lock or config in the push", () => {
    expect(
      shouldForceMutation({
        env: {},
        layer: "",
        files: files(
          `${EXT}/__tests__/support/faker.ts`,
          "package-lock.json",
          "stryker.config.json",
        ),
        support: [`${EXT}/__tests__/support/faker.ts`],
      }),
    ).toBe(false);
  });

  it("forces when asked with MUTATION_FORCE=1, even outside CI and with no trigger in the range", () => {
    expect(
      shouldForceMutation({
        env: { MUTATION_FORCE: "1" },
        layer: "",
        files: files(`${EXT}/config.ts`),
        support: [],
      }),
    ).toBe(true);
  });

  it("in CI, does not force when the range only brings source and spec", () => {
    expect(
      shouldForceMutation({
        env: { CI: "true" },
        layer: "",
        files: files(
          `${EXT}/config.ts`,
          `${EXT}/__tests__/config.test.ts`,
          "scripts/__tests__/stryker-run.test.mjs",
        ),
        support: [],
      }),
    ).toBe(false);
  });

  it("in CI, forces when the range brings a test support file", () => {
    expect(
      shouldForceMutation({
        env: { CI: "true" },
        layer: "",
        files: files("vitest.setup.ts"),
        support: ["vitest.setup.ts"],
      }),
    ).toBe(true);
  });

  for (const trigger of [
    "package.json",
    "package-lock.json",
    "patches/@stryker-mutator+vitest-runner+10.0.0.patch",
    "stryker.config.json",
    "vitest.config.ts",
    "vitest.config.stryker.ts",
  ]) {
    it(`in CI, forces when the range changes ${trigger}, which the incremental does not see`, () => {
      expect(
        shouldForceMutation({
          env: { CI: "true" },
          layer: "",
          files: files(trigger),
          support: [],
        }),
      ).toBe(true);
    });
  }

  it("with a layer folder, only triggers on the layer's own files", () => {
    const base = { env: { CI: "true" }, layer: "sub", support: [] };

    expect(
      shouldForceMutation({ ...base, files: files("sub/package.json") }),
    ).toBe(true);
    expect(
      shouldForceMutation({ ...base, files: files("other/package.json") }),
    ).toBe(false);
  });
});

describe("fitsProgressBar", () => {
  it("uses the bar when the output is a terminal wide enough for Stryker's whole line", () => {
    expect(
      fitsProgressBar({
        isTTY: true,
        columns: STRYKER_PROGRESS_BAR_MIN_COLUMNS,
      }),
    ).toBe(true);
  });

  it("swaps the bar for lines when the terminal is narrower than Stryker's line, which would wrap on every frame", () => {
    expect(
      fitsProgressBar({
        isTTY: true,
        columns: STRYKER_PROGRESS_BAR_MIN_COLUMNS - 1,
      }),
    ).toBe(false);
  });

  it("swaps the bar for lines when the output is not a terminal", () => {
    expect(fitsProgressBar({ isTTY: false, columns: 500 })).toBe(false);
    expect(fitsProgressBar({ isTTY: undefined, columns: 500 })).toBe(false);
  });

  it("swaps the bar for lines when the terminal does not report its width", () => {
    expect(fitsProgressBar({ isTTY: true, columns: undefined })).toBe(false);
  });

  it("the minimum width is the installed Stryker's bar line without the bar itself, where the progress lib starts shrinking the bar to fit", () => {
    const reporter = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "node_modules/@stryker-mutator/core/dist/src/reporters/progress-reporter.js",
      ),
      "utf8",
    );
    const template = /progressBarContent = '([^']+)'/.exec(reporter)?.[1];

    expect(template).toBeTruthy();
    expect(STRYKER_PROGRESS_BAR_MIN_COLUMNS).toBe(
      template.replace(":bar", "").length,
    );
  });
});

describe("isMutationTarget", () => {
  it("accepts the source that matches a positive glob of the mutate", () => {
    expect(isMutationTarget(`${EXT}/config.ts`, EXT_MUTATE)).toBe(true);
    expect(isMutationTarget(`${EXT}/nested/helper.ts`, EXT_MUTATE)).toBe(true);
  });

  it("refuses what a negated glob of the mutate excludes", () => {
    for (const file of [
      `${EXT}/__tests__/config.test.ts`,
      `${EXT}/__tests__/support/helper.ts`,
      "scripts/git.mjs",
    ]) {
      expect([file, isMutationTarget(file, EXT_MUTATE)]).toEqual([file, false]);
    }
  });

  it("refuses the extension that the mutate does not cover", () => {
    expect(isMutationTarget(`${EXT}/view.tsx`, EXT_MUTATE)).toBe(false);
  });
});

describe("specToSource", () => {
  it("maps the spec to the source in the folder above __tests__", () => {
    expect(
      specToSource(`${EXT}/__tests__/config.test.ts`, {
        layer: "",
        exists: existing(`${EXT}/config.ts`),
      }),
    ).toBe(`${EXT}/config.ts`);
  });

  it("shortens the name by segment when the spec is split by concern", () => {
    expect(
      specToSource(`${EXT}/__tests__/config.load.test.ts`, {
        layer: "",
        exists: existing(`${EXT}/config.ts`),
      }),
    ).toBe(`${EXT}/config.ts`);
  });

  it("maps the .test.tsx spec to the .tsx component", () => {
    expect(
      specToSource(`${EXT}/__tests__/Tooltip.test.tsx`, {
        layer: "",
        exists: existing(`${EXT}/Tooltip.tsx`),
      }),
    ).toBe(`${EXT}/Tooltip.tsx`);
  });

  it("maps the .test.tsx spec of a hook to the .ts source", () => {
    expect(
      specToSource(`${EXT}/__tests__/useFieldErrors.test.tsx`, {
        layer: "",
        exists: existing(`${EXT}/useFieldErrors.ts`),
      }),
    ).toBe(`${EXT}/useFieldErrors.ts`);
  });

  it("strips the layer folder before looking for the source", () => {
    expect(
      specToSource(`sub/${EXT}/__tests__/config.test.ts`, {
        layer: "sub",
        exists: existing(`${EXT}/config.ts`),
      }),
    ).toBe(`${EXT}/config.ts`);
  });

  it("returns null when no source exists", () => {
    expect(
      specToSource(`${EXT}/__tests__/nothing.test.ts`, {
        layer: "",
        exists: existing(),
      }),
    ).toBeNull();
  });
});

describe("collectTargets", () => {
  it("separates the push source from the source covered by the push spec, only inside the extensions folder", () => {
    const { directSources, specSources, mutate, unmapped, skipped } =
      collectTargets(
        [
          `${EXT}/config.ts`,
          `${EXT}/__tests__/ask-format.test.ts`,
          "scripts/git.mjs",
          "scripts/__tests__/git.test.mjs",
          `${EXT}/__tests__/support/helper.ts`,
          `${EXT}/__tests__/orphan.test.ts`,
          `${EXT}/__tests__/server.e2e.test.ts`,
        ],
        {
          layer: "",
          mutateGlobs: EXT_MUTATE,
          exists: existing(`${EXT}/ask-format.ts`),
        },
      );

    expect([...directSources]).toEqual([`${EXT}/config.ts`]);
    expect(
      [...specSources.entries()].map(([source, specs]) => [source, [...specs]]),
    ).toEqual([
      [`${EXT}/ask-format.ts`, [`${EXT}/__tests__/ask-format.test.ts`]],
    ]);
    expect([...mutate]).toEqual([`${EXT}/config.ts`, `${EXT}/ask-format.ts`]);
    expect(unmapped).toEqual([`${EXT}/__tests__/orphan.test.ts`]);
    expect(skipped).toEqual([`${EXT}/__tests__/server.e2e.test.ts`]);
  });

  it("leaves out the e2e lane spec, which Stryker does not run, and warns", () => {
    const { mutate, skipped } = collectTargets(
      [`${EXT}/__tests__/server.e2e.test.ts`],
      {
        layer: "",
        mutateGlobs: EXT_MUTATE,
        exists: existing(`${EXT}/server.ts`),
      },
    );

    expect([...mutate]).toEqual([]);
    expect(skipped).toEqual([`${EXT}/__tests__/server.e2e.test.ts`]);
  });

  it("leaves out the source that the spec maps outside the mutate", () => {
    const { mutate, unmapped } = collectTargets(
      [`${EXT}/__tests__/support/helper.test.ts`],
      {
        layer: "",
        mutateGlobs: EXT_MUTATE,
        exists: existing(`${EXT}/__tests__/support/helper.ts`),
      },
    );

    expect([...mutate]).toEqual([]);
    expect(unmapped).toEqual([]);
  });

  it("separates the test support file, without treating it as spec or as source", () => {
    const { mutate, unmapped, support } = collectTargets(
      [
        `${EXT}/config.ts`,
        `${EXT}/__tests__/support/helper.ts`,
        `${EXT}/__tests__/fixtures/message.json`,
        "vitest.setup.ts",
        "scripts/__tests__/fixtures/mutation-report.json",
        `${EXT}/__tests__/support/helper.test.ts`,
      ],
      {
        layer: "",
        mutateGlobs: EXT_MUTATE,
        exists: existing(`${EXT}/__tests__/support/helper.ts`),
      },
    );

    expect([...mutate]).toEqual([`${EXT}/config.ts`]);
    expect(unmapped).toEqual([]);
    expect(support).toEqual([
      `${EXT}/__tests__/support/helper.ts`,
      `${EXT}/__tests__/fixtures/message.json`,
      "vitest.setup.ts",
    ]);
  });

  it("does not mark support when the push only brings source and spec", () => {
    const { support } = collectTargets(
      [`${EXT}/config.ts`, `${EXT}/__tests__/ask-format.test.ts`],
      {
        layer: "",
        mutateGlobs: EXT_MUTATE,
        exists: existing(`${EXT}/ask-format.ts`),
      },
    );

    expect(support).toEqual([]);
  });

  it("with a layer folder, only looks at the layer's own files", () => {
    const { directSources, support } = collectTargets(
      [`sub/${EXT}/config.ts`, `other/${EXT}/config.ts`, "sub/vitest.setup.ts"],
      { layer: "sub", mutateGlobs: EXT_MUTATE, exists: existing() },
    );

    expect([...directSources]).toEqual([`${EXT}/config.ts`]);
    expect(support).toEqual(["vitest.setup.ts"]);
  });
});

describe("restrictTargets", () => {
  const targets = {
    directSources: new Set(["src/a.ts", "src/b.ts"]),
    specSources: new Map([
      ["src/b.ts", new Set(["src/__tests__/b.test.ts"])],
      ["src/c.ts", new Set(["src/__tests__/c.test.ts"])],
    ]),
    mutate: new Set(["src/a.ts", "src/b.ts", "src/c.ts"]),
  };

  it("without a slice list, returns the targets as they came", () => {
    expect(restrictTargets(targets, undefined)).toBe(targets);
    expect(restrictTargets(targets, "")).toBe(targets);
  });

  it("with the slice list, mutates and judges only its files, direct or via spec", () => {
    const sliced = restrictTargets(targets, "src/b.ts,src/c.ts");

    expect([...sliced.mutate]).toEqual(["src/b.ts", "src/c.ts"]);
    expect([...sliced.directSources]).toEqual(["src/b.ts"]);
    expect([...sliced.specSources.keys()].toSorted()).toEqual([
      "src/b.ts",
      "src/c.ts",
    ]);
    expect([...targets.mutate]).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("a slice file that is not among the range's targets stays out", () => {
    const sliced = restrictTargets(targets, "src/a.ts,src/z.ts");

    expect([...sliced.mutate]).toEqual(["src/a.ts"]);
    expect(sliced.specSources.size).toBe(0);
  });
});

describe("main", () => {
  const SCRIPT = join(import.meta.dirname, "..", "mutation-prepush.mjs");
  const ONE_MIB = 1024 * 1024;
  const SVC = `${EXT}/svc.ts`;
  const CHANGED_LINE = "export const pick = (a) => (a > 1 ? 1 : 2);";
  const envWithoutGit = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("GIT_") && name !== "CI" && name !== "MUTATION_FORCE",
    ),
  );
  const fakeStryker = [
    "#!/usr/bin/env node",
    'const { copyFileSync, mkdirSync, writeFileSync } = require("node:fs");',
    'writeFileSync("stryker-args.json", JSON.stringify(process.argv.slice(2)));',
    'mkdirSync("reports/mutation", { recursive: true });',
    'copyFileSync("report.fixture.json", "reports/mutation/report.json");',
  ].join("\n");

  let repo;

  const write = (relativePath, content, mode) => {
    const file = join(repo, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, mode ? { mode } : undefined);
  };

  const git = (...args) => {
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: repo, stdio: "ignore", env: envWithoutGit },
    );
  };

  const readArgs = () =>
    JSON.parse(readFileSync(join(repo, "stryker-args.json"), "utf8"));

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "mutation-prepush-")));
    git("init", "-q", "-b", "main");
    write("stryker.config.json", JSON.stringify({ mutate: EXT_MUTATE }));
    write(
      "mutation-baseline.json",
      JSON.stringify({ [SVC]: { ConditionalExpression: 1 } }),
    );
    write("node_modules/.bin/stryker", fakeStryker, 0o755);
    write(
      ".gitignore",
      "node_modules/\nreports/\nreport.fixture.json\nstryker-args.json\n",
    );
    write(SVC, "// base\nexport const pick = (a) => (a > 0 ? 1 : 2);\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("calls Stryker with the progress in lines when the push output is not a terminal", () => {
    const source = `// base\n${CHANGED_LINE}\n`;
    write(SVC, source);
    git("add", "-A");
    git("commit", "-q", "-m", "line");
    write(
      "report.fixture.json",
      JSON.stringify({ files: { [SVC]: { source, mutants: [] } } }),
    );

    const { status, stderr } = spawnSync(process.execPath, [SCRIPT], {
      cwd: repo,
      encoding: "utf8",
      env: { ...envWithoutGit, MUTATION_RANGE: "HEAD~1..HEAD" },
    });

    expect({ status, stderr }).toMatchObject({ status: 0 });
    const args = readArgs();
    expect(
      args.slice(args.indexOf("--reporters"), args.indexOf("--reporters") + 2),
    ).toEqual(["--reporters", "json,progress-append-only"]);
    expect(args[args.indexOf("--tempDirName") + 1] ?? "").toMatch(
      /^\.stryker-tmp[/\\]run-\d+$/,
    );
    expect(args.slice(-2)).toEqual(["--cleanTempDir", "always"]);
  });

  it("with MUTATION_ONLY, mutates only the slice files among the range's targets", () => {
    const source = `// base\n${CHANGED_LINE}\n`;
    write(SVC, source);
    write(`${EXT}/other.ts`, "export const other = (a) => a + 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "two files");
    write(
      "report.fixture.json",
      JSON.stringify({ files: { [SVC]: { source, mutants: [] } } }),
    );

    const { status, stderr } = spawnSync(process.execPath, [SCRIPT], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...envWithoutGit,
        MUTATION_RANGE: "HEAD~1..HEAD",
        MUTATION_ONLY: SVC,
      },
    });

    expect({ status, stderr }).toMatchObject({ status: 0 });
    const args = readArgs();
    expect(args[args.indexOf("--mutate") + 1]).toBe(SVC);
  });

  for (const [columns, reporter] of [
    [200, "json,progress"],
    [80, "json,progress-append-only"],
  ]) {
    it.skipIf(!hasUtilLinuxScript)(
      `in a terminal of ${columns} columns calls Stryker with the ${reporter} progress`,
      () => {
        const source = `// base\n${CHANGED_LINE}\n`;
        write(SVC, source);
        git("add", "-A");
        git("commit", "-q", "-m", "line");
        write(
          "report.fixture.json",
          JSON.stringify({ files: { [SVC]: { source, mutants: [] } } }),
        );

        const { status, stdout } = spawnSync(
          "script",
          [
            "-qec",
            `stty cols ${columns}; "${process.execPath}" "${SCRIPT}"`,
            "/dev/null",
          ],
          {
            cwd: repo,
            encoding: "utf8",
            env: { ...envWithoutGit, MUTATION_RANGE: "HEAD~1..HEAD" },
          },
        );

        expect({ status, stdout }).toMatchObject({ status: 0 });
        const args = readArgs();
        expect(
          args.slice(
            args.indexOf("--reporters"),
            args.indexOf("--reporters") + 2,
          ),
        ).toEqual(["--reporters", reporter]);
      },
    );
  }

  it("blocks the survivor on a line changed in the push with a diff larger than Node's default buffer, even with a baseline that covers it", () => {
    const source = `// ${"x".repeat(2 * ONE_MIB)}\n${CHANGED_LINE}\n`;
    write(SVC, source);
    git("add", "-A");
    git("commit", "-q", "-m", "big");
    write(
      "report.fixture.json",
      JSON.stringify({
        files: {
          [SVC]: {
            source,
            mutants: [
              {
                ...mutant("ConditionalExpression", 2),
                testsCompleted: 1,
              },
            ],
          },
        },
        testFiles: {
          [`${EXT}/__tests__/svc.test.ts`]: { tests: [{ id: "t1" }] },
        },
      }),
    );

    const { status, stderr } = spawnSync(process.execPath, [SCRIPT], {
      cwd: repo,
      encoding: "utf8",
      env: { ...envWithoutGit, MUTATION_RANGE: "HEAD~1..HEAD" },
    });

    expect({ status, stderr }).toMatchObject({ status: 1 });
    expect(stderr).toMatch(
      /plugins\/telegram\/extensions\/svc\.ts:2 ConditionalExpression.*line changed/,
    );
  });

  describe("--force: full in CI, incremental in the pre-push", () => {
    const pushSourceWithSupport = () => {
      const source = `// base\n${CHANGED_LINE}\n`;
      write(SVC, source);
      write(`${EXT}/__tests__/support/helper.ts`, "export const helper = 1;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "source and support");
      write(
        "report.fixture.json",
        JSON.stringify({ files: { [SVC]: { source, mutants: [] } } }),
      );
    };

    const runGate = (extraEnv = {}) => {
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: repo,
        encoding: "utf8",
        env: { ...envWithoutGit, MUTATION_RANGE: "HEAD~1..HEAD", ...extraEnv },
      });
      return { ...result, args: readArgs() };
    };

    it("in the pre-push, a support file in the push does not force the mutation and warns that the full one runs in CI", () => {
      pushSourceWithSupport();

      const { status, stderr, args } = runGate();

      expect({ status, stderr }).toMatchObject({ status: 0 });
      expect(args.includes("--force")).toBe(false);
      expect(stderr).toMatch(/__tests__\/support\/helper\.ts/);
      expect(stderr).toMatch(/CI/);
    });

    it("with MUTATION_FORCE=1, redoes every mutant of the push with --force, with or without a support file", () => {
      const source = `// base\n${CHANGED_LINE}\n`;
      write(SVC, source);
      git("add", "-A");
      git("commit", "-q", "-m", "source only");
      write(
        "report.fixture.json",
        JSON.stringify({ files: { [SVC]: { source, mutants: [] } } }),
      );

      const { status, stderr, args } = runGate({ MUTATION_FORCE: "1" });

      expect({ status, stderr }).toMatchObject({ status: 0 });
      expect(args.includes("--force")).toBe(true);
    });
  });
});
