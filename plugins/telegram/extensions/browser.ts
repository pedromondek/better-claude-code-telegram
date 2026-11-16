import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

export interface BrowserHost {
  platform: NodeJS.Platform;
  home: string;
  env: Env;
}

type ListDir = (dir: string) => string[];

const PLAYWRIGHT_FOLDER = "ms-playwright";
const CHROMIUM_FOLDER = /^chromium-(\d+)$/;
const NODE_MODULES_INSTALL = "0";

function processHost(): BrowserHost {
  return { platform: process.platform, home: homedir(), env: process.env };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function systemCacheDir({ platform, home, env }: BrowserHost): string {
  if (platform === "darwin") return join(home, "Library", "Caches");

  if (platform === "win32") {
    return nonEmpty(env.LOCALAPPDATA) ?? join(home, "AppData", "Local");
  }

  return nonEmpty(env.XDG_CACHE_HOME) ?? join(home, ".cache");
}

export function playwrightCacheDir(host: BrowserHost = processHost()): string {
  const fromEnv = nonEmpty(host.env.PLAYWRIGHT_BROWSERS_PATH);

  return fromEnv !== undefined && fromEnv !== NODE_MODULES_INSTALL
    ? fromEnv
    : join(systemCacheDir(host), PLAYWRIGHT_FOLDER);
}

function namesIn(
  listDir: ListDir,
  dir: string,
  matches: (name: string) => boolean,
): string[] {
  try {
    return listDir(dir).filter(matches);
  } catch {
    return [];
  }
}

function executableIn(
  platformDir: string,
  platform: NodeJS.Platform,
  listDir: ListDir,
): string | null {
  if (platform === "win32") return join(platformDir, "chrome.exe");

  if (platform !== "darwin") return join(platformDir, "chrome");

  const [app] = namesIn(listDir, platformDir, (name) => name.endsWith(".app"));

  return app
    ? join(platformDir, app, "Contents", "MacOS", app.slice(0, -".app".length))
    : null;
}

const PLATFORM_PREFIXES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "chrome-mac",
  win32: "chrome-win",
};

export function findPlaywrightChromium(
  cacheDir: string,
  platform: NodeJS.Platform = process.platform,
  listDir: ListDir = readdirSync,
): string | null {
  const prefix = PLATFORM_PREFIXES[platform] ?? "chrome-linux";
  const versions = namesIn(listDir, cacheDir, () => true)
    .flatMap((name) => {
      const revision = CHROMIUM_FOLDER.exec(name)?.[1];

      return revision === undefined
        ? []
        : [{ name, revision: Number(revision) }];
    })
    .toSorted((first, second) => second.revision - first.revision)
    .map(({ name }) => name);

  for (const version of versions) {
    const [platformFolder] = namesIn(listDir, join(cacheDir, version), (name) =>
      name.startsWith(prefix),
    );
    const executable = platformFolder
      ? executableIn(join(cacheDir, version, platformFolder), platform, listDir)
      : null;

    if (executable) return executable;
  }

  return null;
}

export function playwrightChromium(
  host: BrowserHost = processHost(),
  listDir: ListDir = readdirSync,
): string | null {
  return findPlaywrightChromium(
    playwrightCacheDir(host),
    host.platform,
    listDir,
  );
}
