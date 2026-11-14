import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ROOT, tasksFor, tasksForFiles } from "./support/lint-staged-tasks.mjs";

const HOOK_TESTS = "npm run --silent test:hooks";
const HOOK = readFileSync(join(ROOT, ".husky", "pre-commit"), "utf8");
const scripts = () =>
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
const quoted = (files) =>
  files.map((file) => `"${join(ROOT, file)}"`).join(" ");
const tool = (command) => `sh scripts/mise-exec.sh ${command}`;
const JACTIONLINT_RULES = [
  "workflow-call-permissions",
  "missing-workflow-input",
  "unknown-workflow-input",
  "workflow-input-type",
  "invalid-local-workflow",
  "pipeline-without-pipefail",
];
const JACTIONLINT = "npm run --silent lint:workflows:jactionlint";
const secretsTask = (...files) => `secretlint --no-glob ${quoted(files)}`;
const typosTask = (...files) =>
  tool(`typos --force-exclude ${files.map((file) => `"${file}"`).join(" ")}`);
const everyFileTasks = (...files) => [
  secretsTask(...files),
  typosTask(...files),
];

function lintTasks(...files) {
  return [
    ...everyFileTasks(...files),
    `prettier --write ${quoted(files)}`,
    `oxlint --fix --max-warnings 0 ${quoted(files)}`,
    `eslint --fix --max-warnings 0 --no-warn-ignored ${quoted(files)}`,
  ];
}

function codeTasks(...files) {
  return [
    ...lintTasks(...files),
    `vitest related --run --passWithNoTests ${quoted(files)}`,
  ];
}

const repositoryFiles = () =>
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);

describe("lint-staged: every file", () => {
  it.each([
    "LICENSE",
    "NOTICE",
    ".gitignore",
    "plugins/telegram/bun.lock",
    "plugins/telegram/server.ts",
    ".husky/pre-commit",
  ])("checks %s for secrets and typos first", (file) => {
    expect(tasksFor(file).slice(0, 2)).toEqual(everyFileTasks(file));
  });

  it("checks every file of the commit in one run of each tool, with secretlint globs off for paths with brackets", () => {
    const files = ["README.md", "plugins/(group)/[id].ts"];

    expect(tasksForFiles(files).slice(0, 2)).toEqual(everyFileTasks(...files));
  });

  it("passes typos the paths relative to the repository, because the folder exclusions of _typos.toml only match relative paths", () => {
    expect(tasksFor("docs/decisions/Fork/001-x.md")[1]).toBe(
      'sh scripts/mise-exec.sh typos --force-exclude "docs/decisions/Fork/001-x.md"',
    );
  });

  it("checks the whole repository by hand through lint:secrets and lint:typos", () => {
    expect(scripts()["lint:secrets"]).toBe('secretlint "**/*"');
    expect(scripts()["lint:typos"]).toBe("sh scripts/mise-exec.sh typos");
  });
});

describe("lint-staged: code", () => {
  it.each([
    "plugins/telegram/extensions/i18n.ts",
    "plugins/telegram-hooks/telegram.mjs",
    "scripts/setup.mjs",
    ".husky/lib/validate-commit-msg.mjs",
    ".husky/__tests__/commit-msg.test.mjs",
  ])(
    "formats %s, passes oxlint and eslint with no warning and runs the related tests",
    (file) => {
      expect(tasksFor(file)).toEqual(codeTasks(file));
    },
  );

  it("runs each tool once with every file of the commit", () => {
    const files = ["scripts/setup.mjs", "plugins/telegram/extensions/i18n.ts"];

    expect(tasksForFiles(files)).toEqual(codeTasks(...files));
  });
});

describe("lint-staged: configs at the root", () => {
  it.each([
    "vitest.config.ts",
    "vitest.config.e2e.ts",
    "vitest.config.stryker.ts",
    "vitest.setup.ts",
    "eslint.config.mjs",
    "lint-staged.config.mjs",
  ])(
    "formats %s and passes oxlint and eslint, without vitest related, which would run the whole suite against the files outside the stage",
    (file) => {
      expect(tasksFor(file)).toEqual(lintTasks(file));
    },
  );

  it("still runs the related tests of the code in folders committed with a config", () => {
    const tasks = tasksForFiles(["vitest.config.ts", "scripts/setup.mjs"]);

    expect(tasks).toContain(
      `vitest related --run --passWithNoTests ${quoted(["scripts/setup.mjs"])}`,
    );
  });
});

describe("lint-staged: data and docs", () => {
  it.each([
    "plugins/telegram/package.json",
    ".oxlintrc.json",
    ".secretlintrc.json",
    "plugins/telegram-hooks/hooks.json",
    "README.md",
    "docs/decisions/Fork/001-x.md",
    ".coderabbit.yaml",
  ])("only formats %s", (file) => {
    expect(tasksFor(file)).toEqual([
      ...everyFileTasks(file),
      `prettier --write ${quoted([file])}`,
    ]);
  });
});

describe("lint-staged: lockfile", () => {
  it.each(["package.json", "package-lock.json", ".lockfile-lintrc.json"])(
    "checks the lock against package.json and its sources when %s changes",
    (file) => {
      expect(tasksFor(file)).toEqual([
        ...everyFileTasks(file),
        `prettier --write ${quoted([file])}`,
        "npm run --silent lint:lockfile",
      ]);
    },
  );

  it("checks the lock once when package.json and the lock change together", () => {
    expect(
      tasksForFiles(["package.json", "package-lock.json"]).filter(
        (task) => task === "npm run --silent lint:lockfile",
      ),
    ).toHaveLength(1);
  });

  it("does not check the lock for any other JSON file, like the manifest of a plugin", () => {
    expect(tasksFor("plugins/telegram/package.json")).not.toContain(
      "npm run --silent lint:lockfile",
    );
  });

  it("lint:lockfile checks the sync with package.json first and then the sources of the lock", () => {
    expect(scripts()["lint:lockfile"]).toBe(
      "node scripts/check-lockfile-sync.mjs && lockfile-lint",
    );
  });
});

describe("lint-staged: workflows and actions", () => {
  it("lints the workflows with four tools, each through the binary mise pins in mise.lock, collected by one runner outside the root lint", () => {
    expect(scripts()["lint:workflows"]).toBe("node scripts/lint-workflows.mjs");
    expect(scripts()["lint:workflows:actionlint"]).toBe(tool("actionlint"));
    expect(scripts()["lint:workflows:jactionlint"]).toBe(
      tool(`jactionlint --select=${JACTIONLINT_RULES.join(",")}`),
    );
    expect(scripts()["lint:workflows:zizmor"]).toBe(
      tool("zizmor --offline --persona=auditor ."),
    );
    expect(scripts()["lint:workflows:pinact"]).toBe(
      tool("pinact run --fix=false --no-api"),
    );
    expect(scripts().lint).not.toMatch(/lint:workflows|mise/u);
  });

  it("keeps the online variants of zizmor and pinact out of lint:workflows, in machine format, for the online audit", () => {
    expect(scripts()["lint:workflows:zizmor:online"]).toBe(
      tool("zizmor --format=json"),
    );
    expect(scripts()["lint:workflows:pinact:online"]).toBe(
      tool("pinact run --check --verify-comment --format sarif"),
    );
    expect(scripts()["audit:workflows"]).toBe(
      "node scripts/workflow-audit.mjs",
    );
    expect(scripts()["lint:workflows"]).not.toMatch(/online/u);
  });

  it.each([".github/workflows/ci.yml", ".github/workflows/release.yaml"])(
    "formats %s and passes actionlint, jactionlint on every workflow, zizmor offline with every audit of the auditor persona and the offline pin check of pinact",
    (file) => {
      expect(tasksFor(file)).toEqual([
        ...everyFileTasks(file),
        `prettier --write ${quoted([file])}`,
        tool(`actionlint ${quoted([file])}`),
        JACTIONLINT,
        tool(`zizmor --offline --persona=auditor ${quoted([file])}`),
        tool(`pinact run --fix=false --no-api ${quoted([file])}`),
      ]);
    },
  );

  it("passes zizmor and pinact on a composite action, which actionlint does not read", () => {
    const file = ".github/actions/setup/action.yml";

    expect(tasksFor(file)).toEqual([
      ...everyFileTasks(file),
      `prettier --write ${quoted([file])}`,
      tool(`zizmor --offline --persona=auditor ${quoted([file])}`),
      tool(`pinact run --fix=false --no-api ${quoted([file])}`),
    ]);
  });

  it("checks every call between workflows again when the jactionlint config changes", () => {
    const file = ".github/jactionlint.yaml";

    expect(tasksFor(file)).toEqual([
      ...everyFileTasks(file),
      `prettier --write ${quoted([file])}`,
      JACTIONLINT,
    ]);
  });

  it("lints every workflow again when the actionlint config changes", () => {
    const file = ".github/actionlint.yaml";

    expect(tasksFor(file)).toEqual([
      ...everyFileTasks(file),
      `prettier --write ${quoted([file])}`,
      tool("actionlint"),
    ]);
  });

  it("passes zizmor on the Dependabot config, which it audits for the cooldown", () => {
    const file = ".github/dependabot.yml";

    expect(tasksFor(file)).toEqual([
      ...everyFileTasks(file),
      `prettier --write ${quoted([file])}`,
      tool(`zizmor --offline --persona=auditor ${quoted([file])}`),
    ]);
  });

  it.each([
    ".claude-plugin/marketplace.json",
    "plugins/bcct/.claude-plugin/plugin.json",
    "plugins/telegram-hooks/hooks/hooks.json",
    "plugins/bcct/skills/update/SKILL.md",
  ])("validates the plugins with claude when %s changes", (file) => {
    expect(tasksFor(file)).toEqual([
      ...everyFileTasks(file),
      `prettier --write ${quoted([file])}`,
      "npm run --silent lint:plugins",
    ]);
  });

  it("audits every workflow again when the zizmor config changes", () => {
    const file = ".github/zizmor.yml";

    expect(tasksFor(file)).toEqual([
      ...everyFileTasks(file),
      `prettier --write ${quoted([file])}`,
      "npm run --silent lint:workflows:zizmor",
    ]);
  });

  it("leaves a YAML file outside .github to prettier only", () => {
    expect(tasksFor("docs/example.yml")).toEqual([
      ...everyFileTasks("docs/example.yml"),
      `prettier --write ${quoted(["docs/example.yml"])}`,
    ]);
  });
});

describe("lint-staged: git hooks", () => {
  it.each([
    ".husky/pre-commit",
    ".husky/commit-msg",
    ".husky/lib/node-env.sh",
    ".husky/lib/progress.sh",
  ])("runs the hook tests when %s changes, without prettier", (file) => {
    expect(tasksFor(file)).toEqual([...everyFileTasks(file), HOOK_TESTS]);
  });

  it("runs the hook tests once for several hook files", () => {
    const files = [".husky/pre-commit", ".husky/lib/progress.sh"];

    expect(tasksForFiles(files)).toEqual([
      ...everyFileTasks(...files),
      HOOK_TESTS,
    ]);
  });

  it("the hook tests run only the tests of .husky", () => {
    expect(scripts()["test:hooks"]).toBe("vitest run .husky");
  });
});

describe("lint-staged: shell scripts", () => {
  it("runs the test named after the shell script, without prettier", () => {
    expect(tasksFor("scripts/telegram.sh")).toEqual([
      ...everyFileTasks("scripts/telegram.sh"),
      'vitest run --passWithNoTests "scripts/__tests__/telegram.test.mjs"',
    ]);
  });

  it("runs the tests of several shell scripts in one go", () => {
    const files = ["scripts/shell.sh", "scripts/telegram.sh"];

    expect(tasksForFiles(files)).toEqual([
      ...everyFileTasks(...files),
      'vitest run --passWithNoTests "scripts/__tests__/shell.test.mjs" "scripts/__tests__/telegram.test.mjs"',
    ]);
  });

  it("every shell script lives in .husky or scripts, and each one in scripts has the test named after it", () => {
    const files = repositoryFiles();
    const shellScripts = files.filter((file) => file.endsWith(".sh"));

    expect(shellScripts).not.toEqual([]);
    expect(
      shellScripts.filter(
        (file) => !file.startsWith(".husky/") && !file.startsWith("scripts/"),
      ),
    ).toEqual([]);
    expect(
      shellScripts
        .filter((file) => file.startsWith("scripts/"))
        .filter(
          (file) =>
            !files.includes(
              file.replace(/([^/]+)\.sh$/u, "__tests__/$1.test.mjs"),
            ),
        ),
    ).toEqual([]);
  });
});

describe("lint-staged: Rust", () => {
  it.each(["rust/crates/bcct/src/lib.rs", "rust/crates/bcct/tests/cli.rs"])(
    "checks %s for secrets and typos, formats it with rustfmt and runs clippy and the tests",
    (file) => {
      expect(tasksFor(file)).toEqual([
        ...everyFileTasks(file),
        `rustfmt --edition 2024 ${quoted([file])}`,
        "npm run --silent rust:lint",
        "npm run --silent rust:test",
      ]);
    },
  );

  it("formats every staged Rust file in one rustfmt run and lints once", () => {
    const files = ["rust/crates/bcct/src/lib.rs", "rust/crates/bcct/src/a.rs"];

    expect(tasksForFiles(files)).toEqual([
      ...everyFileTasks(...files),
      `rustfmt --edition 2024 ${quoted(files)}`,
      "npm run --silent rust:lint",
      "npm run --silent rust:test",
    ]);
  });

  it.each([
    "rust/Cargo.toml",
    "rust/Cargo.lock",
    "rust/deny.toml",
    "rust/crates/bcct/Cargo.toml",
  ])("checks the dependencies of the crates when %s changes", (file) => {
    expect(tasksFor(file)).toEqual([
      ...everyFileTasks(file),
      "npm run --silent rust:deny",
    ]);
  });

  it("checks the dependencies once for several manifests", () => {
    expect(
      tasksForFiles(["rust/Cargo.toml", "rust/Cargo.lock"]).filter(
        (task) => task === "npm run --silent rust:deny",
      ),
    ).toHaveLength(1);
  });

  it("does not run the Rust tasks for a file outside rust/", () => {
    expect(tasksFor("scripts/lib.rs")).toEqual(
      everyFileTasks("scripts/lib.rs"),
    );
  });

  it("runs the Rust gates through the rust:* scripts", () => {
    expect(scripts()).toMatchObject({
      "rust:check":
        "cargo check --manifest-path rust/Cargo.toml --all-targets --locked --quiet --message-format=short",
      "rust:fmt": "cargo fmt --manifest-path rust/Cargo.toml --all --check",
      "rust:clippy":
        "cargo clippy --manifest-path rust/Cargo.toml --all-targets --locked -- -D warnings",
      "rust:lint": "npm run --silent rust:clippy && npm run --silent rust:fmt",
      "rust:test": tool(
        "cargo nextest run --manifest-path rust/Cargo.toml --locked",
      ),
      "rust:cov": tool(
        "cargo llvm-cov nextest --manifest-path rust/Cargo.toml --locked --fail-under-lines 100",
      ),
      "rust:deny": tool(
        "cargo deny --manifest-path rust/Cargo.toml check advisories",
      ),
      "rust:mutation": tool(
        "cargo mutants --manifest-path rust/Cargo.toml --in-place --test-tool=nextest --cargo-test-arg=--max-fail=1:immediate",
      ),
      "rust:mutation:prepush": "node scripts/rust-mutation-prepush.mjs",
      "rust:build":
        "cargo build --manifest-path rust/Cargo.toml --release --locked",
      "rust:clean": "cargo clean --manifest-path rust/Cargo.toml",
    });
  });

  it("keeps the cargo-mutants and build output out of git", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n");

    expect(ignore).toEqual(
      expect.arrayContaining(["target/", "mutants.out/", "mutants.out.old/"]),
    );
  });
});

describe("lint-staged: files with no other task", () => {
  it.each(["LICENSE", "NOTICE", ".gitignore", "plugins/telegram/bun.lock"])(
    "only checks %s for secrets and typos",
    (file) => {
      expect(tasksFor(file)).toEqual(everyFileTasks(file));
    },
  );
});

describe(".husky/pre-commit", () => {
  it("uses the Node version of .nvmrc", () => {
    expect(HOOK.split("\n")[0]).toBe('. "$(dirname "$0")/lib/node-env.sh"');
  });

  it("checks the stage for private data before lint-staged", () => {
    const check = HOOK.indexOf(
      'node "$(dirname "$0")/../scripts/check-private-data.mjs"',
    );

    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(HOOK.indexOf("lint-staged"));
  });

  it("explains a lint-staged failure and keeps its exit code", () => {
    expect(HOOK).toMatch(
      /lint-staged \|\| \{ code=\$\?; node "\$\(dirname "\$0"\)\/lib\/explain-lint-staged-failure\.mjs"; exit "\$code"; \}/,
    );
  });

  it("the private data check also runs by hand through check:private", () => {
    expect(scripts()["check:private"]).toBe(
      "node scripts/check-private-data.mjs",
    );
  });
});
