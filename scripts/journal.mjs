import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function createJournal() {
  const entries = [];
  const tracked = new Set();
  const originals = new Map();

  const record = (kind, target, undo) => {
    entries.push({ kind, target, undo });
  };

  return {
    record,

    trackFile(file) {
      const target = existsSync(file) ? realpathSync(file) : file;

      if (tracked.has(target)) return;

      tracked.add(target);

      if (!existsSync(target)) {
        originals.set(target, null);
        record("fileCreated", target, () => rmSync(target, { force: true }));
        return;
      }

      const content = readFileSync(target);

      originals.set(target, content.toString("utf8"));
      const mode = statSync(target).mode & 0o777;

      record("fileChanged", target, () => {
        writeFileSync(target, content);
        chmodSync(target, mode);
      });
    },

    trackDir(dir) {
      if (existsSync(dir)) return;

      let top = dir;

      while (!existsSync(dirname(top))) top = dirname(top);

      if (tracked.has(top)) return;

      tracked.add(top);
      record("dirCreated", top, () =>
        rmSync(top, { recursive: true, force: true }),
      );
    },

    original(target) {
      return originals.get(target);
    },

    changes() {
      return entries.map(({ kind, target }) => ({ kind, target }));
    },

    undoAll({ onStart = () => {}, onDone = () => {} } = {}) {
      const left = [];

      for (const { kind, target, undo } of entries.toReversed()) {
        let ok = true;

        onStart({ kind, target });

        try {
          if (!undo) throw new Error(kind);
          undo();
        } catch {
          ok = false;
          left.push({ kind, target });
        }

        onDone({ kind, target }, ok);
      }

      entries.length = 0;
      tracked.clear();
      originals.clear();

      return left;
    },
  };
}
