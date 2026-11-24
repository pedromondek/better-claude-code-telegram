import { readFileSync } from "node:fs";

import {
  PATCH_NOTES_HEADING,
  PATCH_NOTES_LANGUAGES,
  PATCH_NOTES_PLACEHOLDER,
  PATCH_NOTES_TEMPLATE,
} from "../../patch-notes.constants.mjs";

export const PATCH_NOTES_RENDERS =
  "scripts/__tests__/fixtures/patch-notes-renders.json";
export const RECORD_COMMAND = "npm run pr:patch-notes:record";

const TEMPLATE = readFileSync(PATCH_NOTES_TEMPLATE, "utf8");
const COMMENT_CLOSER = " -->";
const OPEN_PLACEHOLDER = PATCH_NOTES_PLACEHOLDER.slice(
  0,
  -COMMENT_CLOSER.length,
);
const CLOSES = "Closes #";
const ENGLISH = "### 📋 Summary\n- Buttons answer faster.";
const PORTUGUESE = "### 📋 Resumo\n- Os botões respondem mais rápido.";
const ZERO_WIDTH_CHARACTERS = String.fromCodePoint(
  0x200b,
  0x200c,
  0x200d,
  0x2060,
  0xfeff,
);
const { english: ENGLISH_LABEL, portuguese: PORTUGUESE_LABEL } =
  PATCH_NOTES_LANGUAGES;

function filled(english = ENGLISH, portuguese = PORTUGUESE) {
  return TEMPLATE.replace(PATCH_NOTES_PLACEHOLDER, () => english).replace(
    PATCH_NOTES_PLACEHOLDER,
    () => portuguese,
  );
}

function opened(label, content) {
  return `<details><summary>${label}</summary>\n\n${content}\n\n`;
}

function details(label, content) {
  return `${opened(label, content)}</details>`;
}

function beforeHeading(body, text) {
  return body.replace(
    PATCH_NOTES_HEADING,
    () => `${text}\n\n${PATCH_NOTES_HEADING}`,
  );
}

function afterHeading(body, text) {
  return body.replace(
    PATCH_NOTES_HEADING,
    () => `${PATCH_NOTES_HEADING}\n\n${text}`,
  );
}

function beforeCloses(body, text) {
  return body.replace(CLOSES, () => `${text}\n\n${CLOSES}`);
}

function innerDetails(count) {
  return Array.from({ length: count }, (_, index) =>
    details(`More ${index + 1}`, `Inner ${index + 1}.`),
  ).join("\n\n");
}

function nestedNotes(count) {
  return `- Buttons answer faster.\n\n${innerDetails(count)}\n\n- Voice works offline.`;
}

const codeSpanBefore = beforeHeading(
  filled(),
  "- Checked that `<!--` stays visible.",
);
const summaryQuotesHeading = beforeCloses(
  codeSpanBefore,
  `- The notes go under \`${PATCH_NOTES_HEADING}\`.`,
);
const fencedExample = [
  "```markdown",
  [
    PATCH_NOTES_HEADING,
    details(ENGLISH_LABEL, "- example"),
    details(PORTUGUESE_LABEL, "- exemplo"),
  ].join("\n\n"),
  "```",
].join("\n");

export const PATCH_NOTES_BODIES = {
  filled: filled(),
  template: TEMPLATE,
  englishOnly: details(ENGLISH_LABEL, ENGLISH),
  emptyEnglish: [
    details(ENGLISH_LABEL, "<!-- notes go here -->"),
    details(PORTUGUESE_LABEL, PORTUGUESE),
  ].join("\n\n"),
  placeholderBesideNotes: details(
    ENGLISH_LABEL,
    `${PATCH_NOTES_PLACEHOLDER}\n\n${ENGLISH}`,
  ),
  unclosedPortugueseAtEnd: `${details(ENGLISH_LABEL, ENGLISH)}\n\n<details><summary>${PORTUGUESE_LABEL}</summary>\n\n${PORTUGUESE}\n`,
  wrappedSection: `${filled().replace(PATCH_NOTES_HEADING, () => `<!--\n${PATCH_NOTES_HEADING}`)}\n-->\n`,
  openBeforeHeading: beforeHeading(filled(), "<!--"),
  openAfterHeading: afterHeading(filled(), "<!-- note"),
  openLineInEnglish: filled(OPEN_PLACEHOLDER),
  openMidLineInEnglish: filled("- Fixed a bug <!-- draft"),
  codeSpanBefore,
  fencedBefore: beforeHeading(filled(), "```html\n<!-- open in a fence\n```"),
  summaryQuotesHeading,
  headingTrailingSpaces: summaryQuotesHeading.replace(
    `\n${PATCH_NOTES_HEADING}\n`,
    () => `\n${PATCH_NOTES_HEADING}  \n`,
  ),
  closedCommentWithDetailsEnd: filled(`<!-- </details> -->\n\n${ENGLISH}`),
  closedCommentsInLine: filled("a<!-- b -->c<!-- d -->e"),
  commentBetweenParagraphs: filled(
    "First paragraph.\n\n<!-- todo -->\n\nSecond paragraph.",
  ),
  englishPlaceholderUnclosed: `${PATCH_NOTES_HEADING}\n\n${opened(ENGLISH_LABEL, PATCH_NOTES_PLACEHOLDER)}${details(PORTUGUESE_LABEL, PORTUGUESE)}`,
  englishNotesUnclosed: `${PATCH_NOTES_HEADING}\n\n${opened(ENGLISH_LABEL, ENGLISH)}${details(PORTUGUESE_LABEL, PORTUGUESE)}`,
  orphanPortugueseSummary: `${PATCH_NOTES_HEADING}\n\n${opened(ENGLISH_LABEL, ENGLISH)}<summary>${PORTUGUESE_LABEL}</summary>\n\n${PORTUGUESE}\n\n</details>`,
  earlierExampleHiddenSection: beforeHeading(
    filled("- real note"),
    `${details(ENGLISH_LABEL, "- example")}\n\n${details(PORTUGUESE_LABEL, "- exemplo")}\n\n<!--`,
  ),
  codeSpanComment: filled("- The placeholder `<!-- notes -->` is gone."),
  codeSpanOpenerThenComment: filled(
    "- Fixed the `<!--` parsing.\n- Buttons answer faster. <!-- todo -->",
  ),
  codeSpanDetailsEnd: filled(
    "- Fixed the `</details>` tag.\n- Buttons answer faster.",
  ),
  codeSpansAroundBlocks: afterHeading(
    filled(ENGLISH, "- The arrow `-->` closes it."),
    "- Mind the `<!--` opener.",
  ),
  nestedDetails: filled(nestedNotes(1)),
  fourNestedDetails: filled(nestedNotes(4)),
  fiveNestedDetails: filled(nestedNotes(5)),
  trailingNestedDetails: filled(
    `- Buttons answer faster.\n\n${innerDetails(1)}`,
  ),
  nbspOnly: filled("&nbsp;"),
  zeroWidthOnly: filled(ZERO_WIDTH_CHARACTERS),
  imageOnly: filled("![screenshot](https://example.com/a.png)"),
  detailsOpen: filled("- note").replace(
    `<details><summary>${ENGLISH_LABEL}`,
    () => `<details open><summary>${ENGLISH_LABEL}`,
  ),
  fencedTemplateBeforeRealSection: beforeCloses(
    filled("- real note", "- nota real"),
    fencedExample,
  ),
  referenceLinkAfterBlocks: `${filled("- Read the [docs][1].")}\n[1]: https://example.com\n`,
  collectFirst: filled("- ✨ one", "- ✨ um"),
  collectSecond: filled("- 🐛 two", "- 🐛 dois"),
  collectEnglishOnly: details(ENGLISH_LABEL, "- ✨ one"),
};
