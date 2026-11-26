import { PATCH_NOTES_LANGUAGES } from "./patch-notes.constants.mjs";
import { ANNOUNCE_CHANNELS } from "./release.constants.mjs";

export const ENGLISH_BLOCK = `<details><summary>${PATCH_NOTES_LANGUAGES.english}</summary>`;
export const PORTUGUESE_BLOCK = `<details><summary>${PATCH_NOTES_LANGUAGES.portuguese}</summary>`;
export const BLOCK_END = "</details>";

export const DRAFT_MARK = "<!-- draft -->";
const LINE_BREAK = "\\";
const LEGEND_GAP = "&emsp;&emsp;";
const FOLLOW_TITLE =
  "📣 **Follow the releases on Telegram · Acompanhe os lançamentos no Telegram**";
const FOLLOW_LANGUAGES = [
  {
    language: "en-us",
    flag: "🇺🇸",
    stable: "stable",
    prereleases: "every version",
  },
  {
    language: "pt-br",
    flag: "🇧🇷",
    stable: "estáveis",
    prereleases: "todas as versões",
  },
];
const LEGEND = [
  ["✨", "new", "novo"],
  ["🐛", "fix", "correção"],
  ["⚡", "performance", "desempenho"],
  ["🔐", "security", "segurança"],
];

function channelLink(audience, language) {
  const { chat } = ANNOUNCE_CHANNELS[audience].find(
    (channel) => channel.language === language,
  );

  return `[${chat}](https://t.me/${chat.slice(1)})`;
}

export function followAlert() {
  const languages = FOLLOW_LANGUAGES.map(
    ({ language, flag, stable, prereleases }) =>
      `${flag} ${channelLink("stable", language)} (${stable}) · ${channelLink("prereleases", language)} (${prereleases})`,
  );

  return ["> [!TIP]", FOLLOW_TITLE, ...languages]
    .map((line, index, lines) =>
      index === 0 || index === lines.length - 1 ? line : `${line}${LINE_BREAK}`,
    )
    .map((line) => (line.startsWith(">") ? line : `> ${line}`))
    .join("\n");
}

export function legendAlert() {
  const entries = LEGEND.map(
    ([emoji, english, portuguese]) => `${emoji} ${english} · ${portuguese}`,
  );

  return `> [!NOTE]\n> ${entries.join(LEGEND_GAP)}`;
}

export function emptyNotes() {
  return notesSkeleton("").replace(`${DRAFT_MARK}\n`, "");
}

export function notesSkeleton(draft) {
  return [
    DRAFT_MARK,
    followAlert(),
    "",
    legendAlert(),
    "",
    ENGLISH_BLOCK,
    "",
    ...(draft === "" ? [] : [draft, ""]),
    BLOCK_END,
    "",
    PORTUGUESE_BLOCK,
    "",
    BLOCK_END,
  ].join("\n");
}
