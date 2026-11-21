import { spawnSync } from "node:child_process";

export function commandExists(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const lookup =
    platform === "win32"
      ? spawnSync("where", [command], { stdio: "ignore" })
      : spawnSync("sh", ["-c", 'command -v "$0"', command]);

  return lookup.status === 0;
}

export function runCommand(command: string, args: string[]): number | null {
  return spawnSync(command, args, { stdio: ["ignore", "ignore", "inherit"] })
    .status;
}
