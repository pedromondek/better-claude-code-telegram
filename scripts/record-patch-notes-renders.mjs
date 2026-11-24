import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import {
  PATCH_NOTES_BODIES,
  PATCH_NOTES_RENDERS,
} from "./__tests__/fixtures/patch-notes-bodies.mjs";
import { markdownRenderer, patchNotesFrom } from "./patch-notes.mjs";

const JSON_INDENT = 2;

export function recordRenders(bodies, render) {
  const renders = new Map();
  const memoized = (text) => {
    if (!renders.has(text)) renders.set(text, render(text));

    return renders.get(text);
  };

  for (const body of Object.values(bodies)) patchNotesFrom(body, memoized);

  return Object.fromEntries(renders);
}

function bodyCount(count) {
  return count === 1 ? "1 body" : `${count} bodies`;
}

export function run({ bodies, render, write, out, err }) {
  try {
    const renders = recordRenders(bodies, render);

    write(
      PATCH_NOTES_RENDERS,
      `${JSON.stringify(renders, null, JSON_INDENT)}\n`,
    );
    out(
      `✓ Recorded ${Object.keys(renders).length} GitHub renders of ${bodyCount(Object.keys(bodies).length)} in ${PATCH_NOTES_RENDERS}.`,
    );
    return 0;
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = run({
    bodies: PATCH_NOTES_BODIES,
    render: markdownRenderer(execFileSync),
    write: (file, content) => writeFileSync(file, content),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
