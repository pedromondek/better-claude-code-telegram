import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LINTERS = ["actionlint", "jactionlint", "zizmor", "pinact"];

export function runScript(name) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "--silent", name], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      resolve({ name, ok: false, output: error.message });
    });
    child.on("close", (code) => {
      resolve({ name, ok: code === 0, output });
    });
  });
}

function report(result) {
  if (result.missing) {
    console.log(`✗ ${result.name} is not in package.json`);
    return;
  }

  if (result.ok) {
    console.log(`✓ ${result.name}`);
    return;
  }

  console.log(`✗ ${result.name}`);
  if (result.output.trim()) console.log(result.output.trimEnd());
}

async function main() {
  const { scripts = {} } = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8"),
  );
  const results = await Promise.all(
    LINTERS.map((linter) => {
      const name = `lint:workflows:${linter}`;

      return Object.hasOwn(scripts, name)
        ? runScript(name)
        : { name, ok: false, missing: true, output: "" };
    }),
  );

  results.forEach(report);
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}

if (import.meta.main) {
  await main();
}
