import { TEST_PROGRESS_ENV, writeTestProgress } from "./test-progress.mjs";

export default class VitestProgressReporter {
  constructor(options = {}) {
    this.file = options.file ?? process.env[TEST_PROGRESS_ENV];
    this.finished = 0;
    this.total = 0;
  }

  onTestRunStart(specifications) {
    this.finished = 0;
    this.total = specifications.length;
    this.report();
  }

  onTestModuleEnd() {
    this.finished += 1;
    this.report();
  }

  report() {
    if (this.file) writeTestProgress(this.file, this.finished, this.total);
  }
}
