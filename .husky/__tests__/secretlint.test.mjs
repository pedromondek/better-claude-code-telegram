import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SECRETLINT = join(ROOT, "node_modules", ".bin", "secretlint");
const TELEGRAM_TOKEN = `123456789:${"A".repeat(35)}`;

const SECRETS = {
  "Telegram bot token": [
    "@secretlint/secretlint-rule-pattern",
    `const token = "${TELEGRAM_TOKEN}";`,
  ],
  "Google API key": [
    "@secretlint/secretlint-rule-pattern",
    `const key = "AIza${"c".repeat(35)}";`,
  ],
  "GitHub token": [
    "@secretlint/secretlint-rule-github",
    `const token = "ghp_${"a1".repeat(18)}";`,
  ],
  "Anthropic API key": [
    "@secretlint/secretlint-rule-anthropic",
    `const key = "sk-ant-api03-${"x".repeat(93)}AA";`,
  ],
  "OpenAI API key": [
    "@secretlint/secretlint-rule-openai",
    `const key = "sk-${"b".repeat(20)}T3BlbkFJ${"c".repeat(20)}";`,
  ],
  "npm token": [
    "@secretlint/secretlint-rule-npm",
    `//registry.npmjs.org/:_authToken=npm_${"d".repeat(36)}`,
  ],
  "Slack token": [
    "@secretlint/secretlint-rule-slack",
    `const slack = "xoxb-${"1".repeat(12)}-${"2".repeat(13)}-${"a".repeat(24)}";`,
  ],
  "AWS secret access key": [
    "@secretlint/secretlint-rule-aws",
    `aws_secret_access_key = "${"Q".repeat(40)}"`,
  ],
  "private key": [
    "@secretlint/secretlint-rule-privatekey",
    generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({
      type: "pkcs1",
      format: "pem",
    }),
  ],
};
const LOOKALIKES = [
  "const chat = '123456:short';",
  "const bot = process.env.TELEGRAM_BOT_TOKEN;",
  "const id = 'ghp_short';",
  "const key = 'AIza-not-a-key';",
  "-----BEGIN PUBLIC KEY-----",
].join("\n");

let dir;
let rulesByFile;
let stylish;

function secretlint(...args) {
  return spawnSync(SECRETLINT, ["--no-glob", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bcct-secretlint-"));
  const files = Object.entries(SECRETS).map(([kind, [, content]], index) => {
    const file = join(dir, `leak-${index}.txt`);
    writeFileSync(file, `${content}\n`);

    return [kind, file];
  });
  const lookalikes = join(dir, "lookalikes.ts");
  writeFileSync(lookalikes, LOOKALIKES);

  const report = JSON.parse(
    secretlint("--format", "json", lookalikes, ...files.map(([, f]) => f))
      .stdout,
  );
  const rulesOf = (file) =>
    report
      .filter(({ filePath }) => filePath === file)
      .flatMap(({ messages }) => messages.map(({ ruleId }) => ruleId));

  rulesByFile = Object.fromEntries(
    [...files, ["lookalikes", lookalikes]].map(([kind, file]) => [
      kind,
      rulesOf(file),
    ]),
  );
  stylish = secretlint(files[0][1]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe(".secretlintrc.json", () => {
  it.each(Object.entries(SECRETS))("finds a %s", (kind, [rule]) => {
    expect(rulesByFile[kind]).toContain(rule);
  });

  it("leaves alone values that only look like secrets", () => {
    expect(rulesByFile.lookalikes).toEqual([]);
  });

  it("fails and masks the secret in the report", () => {
    expect(stylish.status).toBe(1);
    expect(stylish.stdout).toContain("leak-0.txt");
    expect(stylish.stdout).not.toContain(TELEGRAM_TOKEN);
  });
});
