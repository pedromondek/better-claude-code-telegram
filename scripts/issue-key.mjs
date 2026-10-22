const KEY_DIGITS = 4;
const SLUG_MAX_LENGTH = 40;

const BRANCH_PATTERN = new RegExp(
  `^(\\d{${KEY_DIGITS},})-[a-z0-9]+(?:-[a-z0-9]+)*$`,
  "u",
);
const PR_TITLE_PATTERN = new RegExp(`^(\\d{${KEY_DIGITS},}): \\S`, "u");
const CLOSING_KEYWORD_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/giu;
const EXEMPT_BRANCHES = [/^main$/u, /^revert\/.+/u, /^dependabot\/.+/u];

export function issueKey(number) {
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`Invalid issue number: ${String(number)}`);
  }

  return String(number).padStart(KEY_DIGITS, "0");
}

export function branchSlug(title) {
  const slug = title
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

  if (slug.length <= SLUG_MAX_LENGTH) return slug;

  const lastBreak = slug.slice(0, SLUG_MAX_LENGTH + 1).lastIndexOf("-");

  return lastBreak > 0
    ? slug.slice(0, lastBreak)
    : slug.slice(0, SLUG_MAX_LENGTH);
}

export function branchName(number, title) {
  const slug = branchSlug(title);

  if (slug === "") {
    throw new TypeError(`Title without text for the branch name: ${title}`);
  }

  return `${issueKey(number)}-${slug}`;
}

function canonicalNumber(digits) {
  const number = Number(digits);

  return issueKey(number) === digits ? number : null;
}

export function issueNumberFromBranch(name) {
  const match = BRANCH_PATTERN.exec(name);

  return match ? canonicalNumber(match[1]) : null;
}

export function isAllowedBranch(name) {
  return (
    issueNumberFromBranch(name) !== null ||
    EXEMPT_BRANCHES.some((pattern) => pattern.test(name))
  );
}

export function prTitle(number, title) {
  return `${issueKey(number)}: ${title.trim()}`;
}

export function issueNumberFromPrTitle(title) {
  const match = PR_TITLE_PATTERN.exec(title);

  return match ? canonicalNumber(match[1]) : null;
}

export function inlineClosingReferences(text) {
  return (text ?? "").split("\n").flatMap((line) => {
    const lineStart = line.length - line.trimStart().length;

    return [...line.matchAll(CLOSING_KEYWORD_PATTERN)]
      .filter((match) => match.index !== lineStart)
      .map((match) => match[0]);
  });
}
