import { REPOSITORY, SETUP_COMMAND } from "../npm/shim/shim.constants.mjs";
import { PATCH_NOTES_LANGUAGES } from "./patch-notes.constants.mjs";
import { installCommand } from "./release-npm-publish.mjs";
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
const CODE_FENCE = "```";
const LAUNCH_COMMAND = "claude --telegram";
const UPDATE_COMMAND = "bcct update";
const UPDATE_SKILL = "/bcct:update";
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

const codeBlock = (command) => [CODE_FENCE, command, CODE_FENCE];

const importantAlert = (lines) =>
  ["[!IMPORTANT]", ...lines].map((line) => `> ${line}`).join("\n");

export function installAlert(version) {
  return importantAlert([
    "🚀 **Install · Instalar**",
    ...codeBlock(installCommand(version)),
    "📌 **This exact version · Esta versão exata**",
    ...codeBlock(`${SETUP_COMMAND}@${version}`),
    `Then · Depois: \`${LAUNCH_COMMAND}\``,
  ]);
}

export function updateAlert(version) {
  return importantAlert([
    "🔄 **Update · Atualizar**",
    ...codeBlock(UPDATE_COMMAND),
    "Or, without bcct on the PATH · Ou, sem o bcct no PATH:",
    ...codeBlock(`${installCommand(version)} update`),
    "Or in Claude Code · Ou no Claude Code:",
    ...codeBlock(UPDATE_SKILL),
  ]);
}

export function releaseUrl(version, repository = REPOSITORY) {
  return `https://github.com/${repository}/releases/tag/v${version}`;
}

export function includesAlert(gathered) {
  const links = gathered.map(
    (version) => `[v${version}](${releaseUrl(version)})`,
  );

  return `> [!NOTE]\n> 📦 **Includes · Inclui:** ${links.join(" · ")}`;
}

export function legendAlert() {
  const entries = LEGEND.map(
    ([emoji, english, portuguese]) => `${emoji} ${english} · ${portuguese}`,
  );

  return `> [!NOTE]\n> ${entries.join(LEGEND_GAP)}`;
}

export function notesSkeleton(draft, version, gathered = []) {
  return [
    DRAFT_MARK,
    followAlert(),
    "",
    installAlert(version),
    "",
    updateAlert(version),
    "",
    ...(gathered.length === 0 ? [] : [includesAlert(gathered), ""]),
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
