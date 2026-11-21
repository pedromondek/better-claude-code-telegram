import { describe, expect, it } from "vitest";

import { parse, parseDocument, visit } from "yaml";

import czConfig from "../../../cz.config.mjs";
import { read } from "../support/workflow.mjs";

const source = read(".github/dependabot.yml");
const config = parse(source);

const anchorsAndAliases = (text) => {
  const found = [];
  visit(parseDocument(text), {
    Alias: (_, node) => {
      found.push(`*${node.source}`);
    },
    Node: (_, node) => {
      if (node.anchor) found.push(`&${node.anchor}`);
    },
  });
  return found;
};

const ECOSYSTEMS = [
  { ecosystem: "npm", directory: "/" },
  { ecosystem: "cargo", directory: "/rust" },
  { ecosystem: "github-actions", directory: "/" },
];

const COOLDOWN_DAYS = 7;
const SECURITY = czConfig.types.find((type) => type.value === "security");
const PREFIX = new RegExp(
  `^${SECURITY.emoji} ${SECURITY.value}\\((${czConfig.scopes.join("|")})\\)$`,
);

const blockOf = ({ ecosystem, directory }) =>
  config.updates.find(
    (block) =>
      block["package-ecosystem"] === ecosystem && block.directory === directory,
  );

describe("dependabot.yml: security updates, and the major versions of grammy", () => {
  it("does not use YAML anchors or aliases, which Dependabot refuses and then ignores the whole file", () => {
    expect(anchorsAndAliases(source)).toEqual([]);
  });

  it("catches both an anchor and an alias", () => {
    expect(
      anchorsAndAliases("a: &base\n  x: 1\nb: *base\n").toSorted(),
    ).toEqual(["&base", "*base"]);
  });

  it("uses syntax version 2", () => {
    expect(config.version).toBe(2);
  });

  it("covers exactly npm in /, cargo in /rust and github-actions in /, plus the bun of the telegram plugin", () => {
    expect(
      config.updates
        .map((block) => `${block["package-ecosystem"]} ${block.directory}`)
        .toSorted(),
    ).toEqual(
      [
        ...ECOSYSTEMS.map(
          ({ ecosystem, directory }) => `${ecosystem} ${directory}`,
        ),
        "bun /plugins/telegram",
      ].toSorted(),
    );
  });

  it("opens only the major versions of grammy in the telegram plugin, checked monthly and 30 days after they come out, since Dependabot makes no security update for bun", () => {
    const upgrade = czConfig.types.find((type) => type.value === "upgrade");

    expect(
      blockOf({ ecosystem: "bun", directory: "/plugins/telegram" }),
    ).toEqual({
      "package-ecosystem": "bun",
      directory: "/plugins/telegram",
      schedule: { interval: "monthly" },
      "open-pull-requests-limit": 1,
      allow: [{ "dependency-name": "grammy" }],
      ignore: [
        {
          "dependency-name": "grammy",
          "update-types": [
            "version-update:semver-minor",
            "version-update:semver-patch",
          ],
        },
      ],
      cooldown: { "semver-major-days": 30 },
      "commit-message": { prefix: `${upgrade.emoji} upgrade(telegram)` },
    });
    expect(czConfig.scopes).toContain("telegram");
  });

  describe.each(ECOSYSTEMS)("$ecosystem in $directory", (target) => {
    const block = blockOf(target);

    it("turns the version updates off with an open pull request limit of 0", () => {
      expect(block["open-pull-requests-limit"]).toBe(0);
    });

    it("waits the minimum release age of 7 days in the cooldown", () => {
      expect(block.cooldown).toEqual({ "default-days": COOLDOWN_DAYS });
    });

    it("groups the security updates and nothing else, over every dependency", () => {
      expect(Object.keys(block.groups)).toEqual(["security"]);
      expect(block.groups.security["applies-to"]).toBe("security-updates");
      expect(block.groups.security.patterns).toEqual(["*"]);
    });

    it("prefixes the commit with the security emoji, the security type and a scope of the cz config", () => {
      expect(block["commit-message"].prefix).toMatch(PREFIX);
    });

    it("has no ignore rule that would hide a vulnerable dependency", () => {
      expect(block.ignore).toBeUndefined();
    });
  });

  it("gives each ecosystem its own scope in the prefix", () => {
    const scopes = ECOSYSTEMS.map(
      (target) => PREFIX.exec(blockOf(target)["commit-message"].prefix)?.[1],
    );

    expect(new Set(scopes).size).toBe(ECOSYSTEMS.length);
  });

  it("reads the security type and its emoji from the cz config", () => {
    expect(SECURITY).toEqual(
      expect.objectContaining({ value: "security", emoji: expect.any(String) }),
    );
    expect(czConfig.scopes.length).toBeGreaterThan(0);
  });
});
