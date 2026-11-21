import { renameSync, rmSync, writeFileSync } from "node:fs";

export const TEST_PROGRESS_ENV = "TEST_PROGRESS_FILE";

export function writeTestProgress(file, finished, total) {
  const temporary = `${file}.${process.pid}.tmp`;

  try {
    writeFileSync(temporary, `${finished} ${total}\n`);
    renameSync(temporary, file);
  } catch {
    rmSync(temporary, { force: true });
    return false;
  }

  return true;
}
