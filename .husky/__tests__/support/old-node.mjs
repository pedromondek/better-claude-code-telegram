import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OLD_NODE_VERSION = "20.0.0";
export const SYSTEM_PATH = "/usr/bin:/bin";
export const OLD_NODE_MESSAGE = `or newer is required, but this is Node ${OLD_NODE_VERSION}`;

export function oldNodeFolder(parent) {
  const folder = join(parent, "old-node");
  const versionOverride = join(folder, "old-version.cjs");
  const node = join(folder, "node");

  mkdirSync(folder, { recursive: true });
  writeFileSync(
    versionOverride,
    `Object.defineProperty(process, "versions", { value: { ...process.versions, node: "${OLD_NODE_VERSION}" } });\n`,
  );
  writeFileSync(
    node,
    `#!/bin/sh\nexec "${process.execPath}" -r "${versionOverride}" "$@"\n`,
  );
  chmodSync(node, 0o755);

  return folder;
}
