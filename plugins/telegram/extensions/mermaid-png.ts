import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findPlaywrightChromium, playwrightCacheDir } from "./browser.ts";
import { commandExists, runCommand } from "./command.ts";
import { defaultAppDir, readLocale } from "./config.ts";
import { messagesFor, type Messages } from "./i18n.ts";

export const MERMAID_SCRIPT = fileURLToPath(import.meta.url);

export function mermaidCommand(): string {
  return `bun "${MERMAID_SCRIPT}"`;
}

export function pngPathFor(inputPath: string): string {
  return inputPath.replace(/\.mmd$/, "") + ".png";
}

export function mmdcArgs(
  inputPath: string,
  outputPath: string,
  puppeteerConfigPath: string | null,
): string[] {
  const args = [
    "-i",
    inputPath,
    "-o",
    outputPath,
    "-b",
    "white",
    "-s",
    "2",
    "--size",
    "1400",
  ];

  return puppeteerConfigPath ? ["-p", puppeteerConfigPath, ...args] : args;
}

interface RenderOptions {
  messages?: Messages;
  playwrightCache?: string;
  hasMmdc?: () => boolean;
  runMmdc?: (args: string[]) => number | null;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export function renderMermaid(
  input: string | undefined,
  {
    messages = messagesFor(readLocale(defaultAppDir())),
    playwrightCache = playwrightCacheDir(),
    hasMmdc = (): boolean => commandExists("mmdc"),
    runMmdc = (args): number | null => runCommand("mmdc", args),
    out = (line): void => console.log(line),
    err = (line): void => console.error(line),
  }: RenderOptions = {},
): number {
  if (!input) {
    err(messages.mermaidUsage(mermaidCommand()));

    return 1;
  }

  if (!hasMmdc()) {
    err(messages.mermaidMissingCli);

    return 1;
  }

  const inputPath = resolve(input);
  const outputPath = pngPathFor(inputPath);
  const chromium = findPlaywrightChromium(playwrightCache);
  const configDir = mkdtempSync(join(tmpdir(), "mermaid-png-"));
  let configPath: string | null = null;

  if (chromium) {
    configPath = join(configDir, "puppeteer-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        executablePath: chromium,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      }),
    );
  }

  const status = runMmdc(mmdcArgs(inputPath, outputPath, configPath));

  rmSync(configDir, { recursive: true, force: true });

  if (status !== 0) {
    err(messages.mermaidFailed(outputPath));

    return status ?? 1;
  }

  out(outputPath);

  return 0;
}

export function runAsScript(argv: string[]): void {
  if (argv[1] === MERMAID_SCRIPT) process.exitCode = renderMermaid(argv[2]);
}

runAsScript(process.argv);
