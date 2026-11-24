import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { recordRenders, run } from "../record-patch-notes-renders.mjs";
import {
  PATCH_NOTES_BODIES as BODIES,
  PATCH_NOTES_RENDERS,
} from "./fixtures/patch-notes-bodies.mjs";

const RENDERS_FILE = "scripts/__tests__/fixtures/patch-notes-renders.json";
const RENDERS = JSON.parse(readFileSync(RENDERS_FILE, "utf8"));

function fakeRender(renderError = null) {
  const calls = [];
  const render = (text) => {
    calls.push(text);

    if (renderError !== null) throw renderError;

    return RENDERS[text];
  };

  return { render, calls };
}

function runWith({ bodies, renderError = null }) {
  const { render, calls } = fakeRender(renderError);
  const writes = [];
  const out = [];
  const err = [];
  const code = run({
    bodies,
    render,
    write: (file, content) => writes.push({ file, content }),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return { code, writes, out: out.join("\n"), err: err.join("\n"), calls };
}

describe("record-patch-notes-renders › recordRenders", () => {
  it("records the body and each candidate block the check renders, once per text", () => {
    const { render, calls } = fakeRender();
    const renders = recordRenders(
      {
        first: BODIES.filled,
        again: BODIES.filled,
        code: BODIES.codeSpanComment,
      },
      render,
    );

    expect(Object.keys(renders)).toEqual([
      BODIES.filled,
      "### 📋 Summary\n- Buttons answer faster.",
      "### 📋 Resumo\n- Os botões respondem mais rápido.",
      BODIES.codeSpanComment,
      "- The placeholder `` is gone.",
      "- The placeholder `<!-- notes -->` is gone.",
    ]);
    expect(calls).toEqual(Object.keys(renders));
    expect(renders[BODIES.filled]).toBe(RENDERS[BODIES.filled]);
  });

  it("keeps in the fixture exactly the texts the bodies ask for", () => {
    const { render } = fakeRender();

    expect(recordRenders(BODIES, render)).toEqual(RENDERS);
  });
});

describe("record-patch-notes-renders › run", () => {
  it("writes the renders as JSON to the fixture and names the count", () => {
    const { code, writes, out } = runWith({
      bodies: { first: BODIES.englishOnly },
    });

    expect(code).toBe(0);
    expect(writes).toEqual([
      {
        file: RENDERS_FILE,
        content: `${JSON.stringify(
          {
            [BODIES.englishOnly]: RENDERS[BODIES.englishOnly],
            "### 📋 Summary\n- Buttons answer faster.":
              RENDERS["### 📋 Summary\n- Buttons answer faster."],
          },
          null,
          2,
        )}\n`,
      },
    ]);
    expect(out).toBe(
      "✓ Recorded 2 GitHub renders of 1 body in scripts/__tests__/fixtures/patch-notes-renders.json.",
    );
  });

  it("counts the bodies in the plural", () => {
    const { out } = runWith({
      bodies: { first: BODIES.englishOnly, second: BODIES.collectEnglishOnly },
    });

    expect(out).toBe(
      "✓ Recorded 4 GitHub renders of 2 bodies in scripts/__tests__/fixtures/patch-notes-renders.json.",
    );
  });

  it("fails with the gh error without writing when a text cannot be rendered", () => {
    const { code, writes, err } = runWith({
      bodies: { first: BODIES.filled },
      renderError: new Error("HTTP 403: API rate limit exceeded"),
    });

    expect(code).toBe(1);
    expect(err).toBe("✗ HTTP 403: API rate limit exceeded");
    expect(writes).toEqual([]);
  });

  it("names the fixture and the record script the specs point at", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));

    expect(PATCH_NOTES_RENDERS).toBe(RENDERS_FILE);
    expect(scripts["pr:patch-notes:record"]).toBe(
      "node scripts/record-patch-notes-renders.mjs",
    );
  });
});
