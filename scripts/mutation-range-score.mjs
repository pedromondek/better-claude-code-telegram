import { existsSync, readFileSync } from "node:fs";

import { formatScore, scoreFile } from "./mutation-report.mjs";

const REPORT_PATH = "reports/mutation/report.json";

function parseRanges(argument) {
  return argument.split(",").map((entry) => {
    const [file, range] = entry.split(":");
    const [start, end] = (range ?? "").split("-").map(Number);

    if (!file || Number.isNaN(start) || Number.isNaN(end)) {
      throw new Error(`invalid range: ${entry} (use file:start-end)`);
    }

    return { file, start, end };
  });
}

function main() {
  const [rangesArgument, reportPath = REPORT_PATH] = process.argv.slice(2);

  if (!rangesArgument) {
    console.error(
      'usage: npm run test:mutation:score -- "file:start-end,file:start-end"',
    );
    process.exitCode = 1;

    return;
  }

  let ranges;
  try {
    ranges = parseRanges(rangesArgument);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;

    return;
  }

  if (!existsSync(reportPath)) {
    console.error(`report not found: ${reportPath}`);
    process.exitCode = 1;

    return;
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"));

  for (const range of ranges) {
    const label = `${range.file}:${range.start}-${range.end}`;

    for (const line of formatScore(
      label,
      scoreFile(report, range.file, range),
    )) {
      console.log(line);
    }
  }
}

main();
