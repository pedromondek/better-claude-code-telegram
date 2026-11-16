import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TempKind = "capture" | "frames" | "board";

export const CHROMIUM_PID_FILE = "chromium.pid";

const LEFTOVER = /^bcct-(?:capture|frames|board)-(\d+)-/;

interface LeftoverDeps {
  listDir?: (dir: string) => string[];
  isAlive?: (pid: number) => boolean;
  readText?: (path: string) => string | null;
  kill?: (pid: number) => void;
  remove?: (path: string) => void;
}

export function tempPrefix(kind: TempKind, pid: number = process.pid): string {
  return `bcct-${kind}-${pid}-`;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path).toString();
  } catch {
    return null;
  }
}

export function killHard(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function cleanLeftovers(
  dir: string = tmpdir(),
  {
    listDir = listNames,
    isAlive = processAlive,
    readText = readTextOrNull,
    kill = killHard,
    remove = removeTree,
  }: LeftoverDeps = {},
): string[] {
  const removed: string[] = [];

  for (const name of listDir(dir)) {
    const owner = LEFTOVER.exec(name)?.[1];

    if (owner === undefined || isAlive(Number(owner))) continue;

    const path = join(dir, name);
    const chromium = Number(readText(join(path, CHROMIUM_PID_FILE)));
    const usesProfile =
      readText(`/proc/${chromium}/cmdline`)
        ?.split(/[\0 ]/)
        .includes(`--user-data-dir=${path}`) === true;

    if (chromium > 0 && usesProfile) kill(chromium);

    remove(path);
    removed.push(path);
  }

  return removed;
}
