import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { read } from "../support/workflow.mjs";

const config = parse(read(".github/pinact.yaml"));
const scripts = JSON.parse(read("package.json")).scripts;

describe("pinact.yaml: the minimum release age of the actions", () => {
  it("holds every action to the minimum age, with no exception left", () => {
    expect(config).toEqual({ version: 3, min_age: { value: 7 } });
  });

  it("takes the age from minimum_release_age of mise.toml, the one rule of the project for a new version", () => {
    const [, days] = /^minimum_release_age = "(\d+)d"$/mu.exec(
      read("mise.toml"),
    );

    expect(config.min_age.value).toBe(Number(days));
  });

  it("checks the age of the pinned versions only in the online audit, since it reads the release dates from the API", () => {
    expect(scripts["lint:workflows:pinact:online"]).toBe(
      "sh scripts/mise-exec.sh pinact run --check --verify-comment --verify-min-age --format sarif",
    );
    expect(scripts["lint:workflows:pinact"]).toBe(
      "sh scripts/mise-exec.sh pinact run --fix=false --no-api",
    );
  });
});
