const CLOSING_KEYWORD_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/giu;

export function inlineClosingReferences(text) {
  return (text ?? "").split("\n").flatMap((line) => {
    const lineStart = line.length - line.trimStart().length;

    return [...line.matchAll(CLOSING_KEYWORD_PATTERN)]
      .filter((match) => match.index !== lineStart)
      .map((match) => match[0]);
  });
}
