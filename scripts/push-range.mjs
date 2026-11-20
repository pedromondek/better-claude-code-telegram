import { git } from "./git.mjs";

function gitOutput(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

export function pushRange({ env = process.env, run = gitOutput } = {}) {
  if (env.MUTATION_RANGE) {
    return env.MUTATION_RANGE;
  }

  if (env.MUTATION_BEFORE) {
    return `${env.MUTATION_BEFORE}...HEAD`;
  }

  const upstream = run([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]).trim();

  if (upstream) {
    return `${upstream}...HEAD`;
  }

  const base = run(["merge-base", "origin/main", "HEAD"]).trim();

  return base ? `${base}...HEAD` : "HEAD~1..HEAD";
}
