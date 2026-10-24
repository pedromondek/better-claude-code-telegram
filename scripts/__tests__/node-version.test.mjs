import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import nodeVersion from "../node-version.cjs";
import { MINIMUM_NODE } from "../setup.mjs";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const { minimumNode, nodeIsSupported, nodeTooOldMessage } = nodeVersion;

describe("node-version", () => {
  it("reads the minimum from the engines of package.json, the same the setup uses", () => {
    const { engines } = JSON.parse(
      readFileSync(join(ROOT_DIR, "package.json"), "utf8"),
    );

    expect(minimumNode()).toBe(engines.node.replace(">=", ""));
    expect(minimumNode().startsWith(`${MINIMUM_NODE}.`)).toBe(true);
  });

  it("accepts the minimum and anything newer, and refuses anything older", () => {
    expect(nodeIsSupported("24.11.0", "24.11.0")).toBe(true);
    expect(nodeIsSupported("24.20.1", "24.11.0")).toBe(true);
    expect(nodeIsSupported("25.0.0", "24.11.0")).toBe(true);
    expect(nodeIsSupported("24.10.9", "24.11.0")).toBe(false);
    expect(nodeIsSupported("22.20.0", "24.11.0")).toBe(false);
    expect(nodeIsSupported("18.0.0", "24.11.0")).toBe(false);
  });

  it("explains in both languages what is needed and what was found", () => {
    expect(nodeTooOldMessage("18.0.0", "24.11.0")).toBe(
      "[en-us] Node 24.11.0 or newer is required, but this is Node 18.0.0. Install a newer Node (the .nvmrc of this repository pins the tested one) and run the command again.\n[pt-br] É preciso o Node 24.11.0 ou mais novo, mas este é o Node 18.0.0. Instale um Node mais novo (o .nvmrc deste repositório fixa o testado) e rode o comando de novo.",
    );
  });

  it("lets the command run when the Node of the machine is supported", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-r",
        join(ROOT_DIR, "scripts", "require-node.cjs"),
        "-e",
        "console.log('ran')",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ran\n");
  });

  it("runs the check before every setup, uninstall and health script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT_DIR, "package.json"), "utf8"),
    );
    const guarded = Object.entries(scripts).filter(([name]) =>
      /^(setup|uninstall|health)(:|$)/.test(name),
    );

    expect(guarded.length).toBeGreaterThan(10);
    for (const [, command] of guarded) {
      expect(command.startsWith("node -r ./scripts/require-node.cjs ")).toBe(
        true,
      );
    }
  });
});
