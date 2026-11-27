import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { COMMAND, REPOSITORY } from "../npm/shim/shim.constants.mjs";
import { PORTUGUESE_BLOCK, releaseUrl } from "./release-notes-layout.mjs";
import { installCommand } from "./release-npm-publish.mjs";
import { notesPath } from "./release-pr.mjs";
import {
  ANNOUNCE_CHANNELS,
  ANNOUNCE_PAUSE_MS,
  ANNOUNCE_RETRIES,
  TELEGRAM_API,
} from "./release.constants.mjs";
import { compareVersions, gatheredVersions } from "./release-order.mjs";
import { isVersion, parseVersion } from "./version.mjs";

const USAGE =
  "usage: npm run release:announce -- [--print] [--root <folder>] | link (version in VERSION)";
const TELEGRAM_LINE_PREFIX = "📣 Telegram: ";
const TELEGRAM_LINE = /^📣 Telegram: (.*)$/mu;
const TELEGRAM_LINE_WITH_GAP = /(?:\r?\n\r?\n)?^📣 Telegram: .*$/mu;
const TELEGRAM_LINK = /\[(@\w+)\]\((https:\/\/t\.me\/[^)\s]+)\)/gu;
const NO_RELEASE = "release not found";
const NOTHING_TO_RECORD = "nothing to record: no channel posted an opening";
const OPENINGS_SHAPE =
  "OPENINGS must be a JSON object of channel to opening id";
const SUMMARY_HEADINGS = {
  "en-us": "### 📋 Summary",
  "pt-br": "### 📋 Resumo",
};
const FEATURE_BULLET = "- ✨ ";
const LEADING_SPARKLE = /^✨ /u;
const MEDIA_LINES = {
  gif: /^ {2,}!\[[^\]]*\]\(([^)\s]+)\)\s*$/u,
  video: /^ {2,}<!--\s*telegram:\s*(\S+)\s*-->\s*$/u,
};
const ITEM_BODY_LINE = /^(?:\s+\S|\s*$)/u;
const PARAGRAPH_LINE = /^ {2,}\S/u;
const COMMENT_LINE = /^ {2,}<!--.*-->\s*$/u;
const PRERELEASE_NOTES = /^((?:alpha|beta|rc)\.\d+)\.md$/u;
const ALL_CHANNELS = [
  ...ANNOUNCE_CHANNELS.stable,
  ...ANNOUNCE_CHANNELS.prereleases,
];
const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;
const ANIMATION_LIMIT_BYTES = 50 * 1024 * 1024;
const CODE_SPAN = /`([^`]+)`/gu;
const CODE_PLACEHOLDER = /<(\d+)>/gu;
const RESUME_ENTRY = /^(@\w+)=(?:done|(\d+):(\d+))$/u;
const RESUME_TEST = "test=";
const OPENING_ID = "<opening id>";
const OPENING_ID_HINT =
  "the opening id is the number at the end of its t.me link";
const RESUME_FORMAT = "<channel>=done or <channel>=<opening id>:<posts sent>";
const ENTITY_WITHOUT_CODE = /<b>.*?<\/b>|<a href="[^"]*">.*?<\/a>/gu;
const PREVIEW_LENGTH = 40;
const MEDIA_TYPES = {
  ".gif": { contentType: "image/gif", fileName: "animation.gif" },
  ".mp4": { contentType: "video/mp4", fileName: "animation.mp4" },
};
const EXTENSION_OF_LINE = { gif: ".gif", video: ".mp4" };
const WORDING = {
  "en-us": {
    notes: "Release notes",
    install: "Install",
    stable: "is stable",
    includes: "Includes:",
  },
  "pt-br": {
    notes: "Notas da versão",
    install: "Instalar",
    stable: "está estável",
    includes: "Inclui:",
  },
};

const escapeHtml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function toTelegramHtml(markdown) {
  const codeSpans = [];
  const codeText = (_placeholder, index) => codeSpans[Number(index)];

  return escapeHtml(markdown)
    .replaceAll(CODE_SPAN, (_span, code) => {
      codeSpans.push(code);
      return `<${codeSpans.length - 1}>`;
    })
    .replaceAll(/\*\*(.+?)\*\*/gu, "<b>$1</b>")
    .replaceAll(
      /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/gu,
      (_link, text, url) =>
        `<a href="${url.replaceAll('"', "&quot;")}">${text}</a>`,
    )
    .replaceAll(ENTITY_WITHOUT_CODE, (entity) =>
      entity.replaceAll(CODE_PLACEHOLDER, codeText),
    )
    .replaceAll(
      CODE_PLACEHOLDER,
      (placeholder, index) => `<code>${codeText(placeholder, index)}</code>`,
    );
}

const withoutSparkle = (text) => text.replace(LEADING_SPARKLE, "");

const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);

function visibleLength(html) {
  return html
    .replaceAll(/<[^>]+>/gu, "")
    .replaceAll(/&(?:amp|lt|gt|quot);/gu, "&").length;
}

function preview(text) {
  return text.length > PREVIEW_LENGTH
    ? `${text.slice(0, PREVIEW_LENGTH - 1)}…`
    : text;
}

function paragraphsOf(body) {
  const paragraphs = [];
  let current = [];

  for (const line of [...body, ""]) {
    if (
      PARAGRAPH_LINE.test(line) &&
      !MEDIA_LINES.gif.test(line) &&
      !COMMENT_LINE.test(line)
    ) {
      current.push(line.trim());
    } else if (current.length > 0) {
      paragraphs.push(current.join(" "));
      current = [];
    }
  }

  return paragraphs;
}

function itemBody(lines) {
  const end = lines.findIndex((line) => !ITEM_BODY_LINE.test(line));
  const body = lines.slice(0, end === -1 ? lines.length : end);
  const firstMatch = (pattern) =>
    body
      .map((line) => pattern.exec(line))
      .find((match) => match !== null)?.[1] ?? null;

  return {
    paragraphs: paragraphsOf(body),
    gif: firstMatch(MEDIA_LINES.gif),
    video: firstMatch(MEDIA_LINES.video),
  };
}

function mediaOf(url, line) {
  const extension = extname(new URL(url).pathname).toLowerCase();
  const key = extension === "" ? EXTENSION_OF_LINE[line] : extension;

  if (!Object.hasOwn(MEDIA_TYPES, key)) {
    throw new Error(
      `${url} has the extension ${extension}, but the announcement sends only .gif and .mp4`,
    );
  }

  return MEDIA_TYPES[key];
}

function readPart(part, language, file) {
  const lines = part.split("\n");
  const heading = SUMMARY_HEADINGS[language];
  const at = lines.findIndex((line) => line.trim() === heading);

  if (at === -1) {
    throw new Error(`${file} has no ${heading} in the ${language} part`);
  }

  const afterHeading = lines.slice(at + 1);
  const nextHeading = afterHeading.findIndex((line) => line.startsWith("### "));
  const summary = afterHeading
    .slice(0, nextHeading === -1 ? afterHeading.length : nextHeading)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
  const features = lines.flatMap((line, index) =>
    line.startsWith(FEATURE_BULLET)
      ? [{ text: line.slice(2).trim(), ...itemBody(lines.slice(index + 1)) }]
      : [],
  );

  return { summary, features };
}

export function parseNotes(text, file) {
  const notes = text.replaceAll("\r\n", "\n");
  const start = notes.indexOf(PORTUGUESE_BLOCK);

  if (start === -1) {
    throw new Error(`${file} has no ${PORTUGUESE_BLOCK} block`);
  }

  const english = readPart(notes.slice(0, start), "en-us", file);
  const portuguese = readPart(
    notes.slice(start + PORTUGUESE_BLOCK.length),
    "pt-br",
    file,
  );

  if (english.features.length !== portuguese.features.length) {
    throw new Error(
      `${file} has ${english.features.length} ✨ items in en-us and ${portuguese.features.length} in pt-br, which pair by order`,
    );
  }

  return {
    "en-us": english,
    "pt-br": {
      summary: portuguese.summary,
      features: portuguese.features.map(
        ({ text: itemText, paragraphs, video }, index) => ({
          text: itemText,
          paragraphs,
          gif: english.features[index].gif,
          video: video ?? english.features[index].video,
        }),
      ),
    },
  };
}

function readNotes(root, version) {
  const file = notesPath(version);
  const path = join(root, file);

  if (!existsSync(path)) {
    throw new Error(
      `there are no notes of v${version} in ${file}, which the release records`,
    );
  }

  return parseNotes(readFileSync(path, "utf8"), file);
}

const normalizedText = (text) =>
  text.trim().replaceAll(/\s+/gu, " ").toLowerCase();

function folderNotes(root, version) {
  const folder = dirname(notesPath(version));

  if (!existsSync(join(root, folder))) {
    return [];
  }

  return readdirSync(join(root, folder)).flatMap((name) => {
    const stage = PRERELEASE_NOTES.exec(name)?.[1];

    return stage === undefined
      ? []
      : [{ version: `${basename(folder)}-${stage}`, path: join(folder, name) }];
  });
}

const demoOf = ({ video, gif }) => video ?? gif;

function alreadyPosted(item, seen) {
  const demo = demoOf(item);

  return seen.some((earlier) =>
    demo === null
      ? demoOf(earlier) === null &&
        normalizedText(earlier.text) === normalizedText(item.text)
      : demoOf(earlier) === demo,
  );
}

function freshFeatures(root, version, features) {
  const seen = folderNotes(root, version)
    .filter((notes) => compareVersions(notes.version, version) < 0)
    .flatMap(
      ({ path }) =>
        parseNotes(readFileSync(join(root, path), "utf8"), path)["en-us"]
          .features,
    );

  return features.map((item) => !alreadyPosted(item, seen));
}

function gatheredOf(root, version) {
  return gatheredVersions(
    version,
    folderNotes(root, version).map((notes) => notes.version),
  );
}

function hrefOf(url) {
  return escapeHtml(url).replaceAll('"', "&quot;");
}

function telegramLinkOf(records, version, { chat, language }) {
  const recorded = records[version] ?? {};
  const prereleaseChat = ANNOUNCE_CHANNELS.prereleases.find(
    (channel) => channel.language === language,
  )?.chat;

  return recorded[chat] ?? recorded[prereleaseChat] ?? null;
}

function includesLines(channel, { gathered, records, repository }) {
  if (gathered.length === 0) {
    return [];
  }

  return [
    WORDING[channel.language].includes,
    ...gathered.flatMap((gatheredVersion) => {
      const telegram = telegramLinkOf(records, gatheredVersion, channel);
      const release = `<a href="${hrefOf(releaseUrl(gatheredVersion, repository))}">🔗 Release</a>`;

      return [
        `• v${gatheredVersion}`,
        telegram === null
          ? `   ${release}`
          : `   <a href="${hrefOf(telegram)}">📣 Telegram</a> · ${release}`,
      ];
    }),
    "",
  ];
}

function openingText({ marker, title, bullets, channel, context }) {
  const { version, repository } = context;
  const wording = WORDING[channel.language];

  return [
    `${marker} ${title}`,
    "",
    ...(bullets.length > 0
      ? [...bullets.map((bullet) => `• ${toTelegramHtml(bullet)}`), ""]
      : []),
    ...includesLines(channel, context),
    `<a href="${releaseUrl(version, repository)}">📝 ${wording.notes}</a>`,
    `${wording.install}: <code>${escapeHtml(installCommand(version))}</code>`,
  ].join("\n");
}

function announcement({ chat, language }, { opening, features }) {
  const length = visibleLength(opening);

  if (length > MESSAGE_LIMIT) {
    throw new Error(
      `the opening of ${chat} has ${length} characters, over the ${MESSAGE_LIMIT} Telegram takes`,
    );
  }

  const animations = features
    .filter(({ gif, video }) => gif !== null || video !== null)
    .map(({ text, paragraphs, gif, video }) => {
      const sent =
        video === null
          ? { url: gif, line: "gif" }
          : { url: video, line: "video" };
      const caption = toTelegramHtml(
        [withoutSparkle(text), ...paragraphs].join("\n\n"),
      );
      const captionLength = visibleLength(caption);

      if (captionLength > CAPTION_LIMIT) {
        throw new Error(
          `the ✨ item "${preview(text)}" of ${chat} makes a caption of ${captionLength} characters, over the ${CAPTION_LIMIT} Telegram takes`,
        );
      }

      return {
        method: "sendAnimation",
        caption,
        animation: sent.url,
        ...mediaOf(sent.url, sent.line),
      };
    });

  return {
    chat,
    language,
    posts: [{ method: "sendMessage", text: opening }, ...animations],
  };
}

const onlyFresh = (features, fresh) =>
  features.filter((_feature, index) => fresh[index]);

function fullAnnouncement(channel, notes, marker, context, postedFeatures) {
  const { summary, features } = notes[channel.language];

  return announcement(channel, {
    opening: openingText({
      marker,
      title: `<b>${COMMAND} ${context.version}</b>`,
      bullets: summary,
      channel,
      context,
    }),
    features: postedFeatures(features),
  });
}

function stableNewsAnnouncement(channel, notes, fresh, context) {
  const features = onlyFresh(notes[channel.language].features, fresh);

  return announcement(channel, {
    opening: openingText({
      marker: "✅",
      title: `<b>${context.version}</b> ${WORDING[channel.language].stable}`,
      bullets: features.map(({ text }) => withoutSparkle(text)),
      channel,
      context: { ...context, gathered: [] },
    }),
    features,
  });
}

export function buildAnnouncements({
  root,
  version,
  repository,
  records = {},
}) {
  const notes = readNotes(root, version);
  const context = {
    version,
    repository,
    records,
    gathered: gatheredOf(root, version),
  };
  const fresh = freshFeatures(root, version, notes["en-us"].features);

  if (parseVersion(version).stage !== null) {
    return ANNOUNCE_CHANNELS.prereleases.map((channel) =>
      fullAnnouncement(channel, notes, "🧪", context, (features) =>
        onlyFresh(features, fresh),
      ),
    );
  }

  return [
    ...ANNOUNCE_CHANNELS.stable.map((channel) =>
      fullAnnouncement(channel, notes, "🚀", context, (features) => features),
    ),
    ...ANNOUNCE_CHANNELS.prereleases.map((channel) =>
      stableNewsAnnouncement(channel, notes, fresh, context),
    ),
  ];
}

export function parseTelegramLine(body) {
  const line = TELEGRAM_LINE.exec(body)?.[1] ?? "";

  return Object.fromEntries(
    [...line.matchAll(TELEGRAM_LINK)].map(([, chat, url]) => [chat, url]),
  );
}

export function telegramLine(links) {
  const entries = ALL_CHANNELS.filter(({ chat }) =>
    Object.hasOwn(links, chat),
  ).map(({ chat }) => `[${chat}](${links[chat]})`);

  return entries.length === 0
    ? ""
    : `${TELEGRAM_LINE_PREFIX}${entries.join(" · ")}`;
}

export function ghGithub(repository, execFile = execFileSync) {
  const options = { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] };

  return {
    releaseBody(tag) {
      try {
        return execFile(
          "gh",
          [
            "release",
            "view",
            tag,
            "--repo",
            repository,
            "--json",
            "body",
            "--jq",
            ".body",
          ],
          options,
        ).replace(/\n$/u, "");
      } catch (error) {
        if (`${error.stderr ?? ""}`.includes(NO_RELEASE)) {
          return null;
        }

        throw error;
      }
    },
    editReleaseBody(tag, body) {
      execFile(
        "gh",
        ["release", "edit", tag, "--repo", repository, "--notes-file", "-"],
        { ...options, input: body },
      );
    },
  };
}

function recordToGithubOutput(env) {
  return (openings) => {
    if (env.GITHUB_OUTPUT) {
      appendFileSync(
        env.GITHUB_OUTPUT,
        `openings=${JSON.stringify(openings)}\n`,
      );
    }
  };
}

async function readRecords(github, gathered) {
  const bodies = await Promise.all(
    gathered.map((gatheredVersion) =>
      github.releaseBody(`v${gatheredVersion}`),
    ),
  );

  return Object.fromEntries(
    gathered.flatMap((gatheredVersion, index) =>
      bodies[index] === null
        ? []
        : [[gatheredVersion, parseTelegramLine(bodies[index])]],
    ),
  );
}

function parseOpenings(text) {
  if (text.trim() === "") {
    return {};
  }

  let openings;

  try {
    openings = JSON.parse(text);
  } catch {
    throw new Error(OPENINGS_SHAPE);
  }

  if (
    typeof openings !== "object" ||
    openings === null ||
    Array.isArray(openings)
  ) {
    throw new Error(OPENINGS_SHAPE);
  }

  for (const [chat, id] of Object.entries(openings)) {
    if (!ALL_CHANNELS.some((channel) => channel.chat === chat)) {
      throw new Error(`OPENINGS: ${chat} is not a channel of the announcement`);
    }

    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(
        `OPENINGS: the opening id of ${chat} must be a positive integer`,
      );
    }
  }

  return openings;
}

async function linkOpenings({ version, env, github, out }) {
  const openings = parseOpenings(env.OPENINGS ?? "");
  const chats = Object.keys(openings);

  if (chats.length === 0) {
    out(NOTHING_TO_RECORD);
    return;
  }

  const tag = `v${version}`;
  const body = await github.releaseBody(tag);

  if (body === null) {
    throw new Error(
      `there is no Release ${tag} to record the Telegram links in`,
    );
  }

  const links = {
    ...parseTelegramLine(body),
    ...Object.fromEntries(
      chats.map((chat) => [
        chat,
        `https://t.me/${chat.slice(1)}/${openings[chat]}`,
      ]),
    ),
  };
  const kept = body.replace(TELEGRAM_LINE_WITH_GAP, "").trimEnd();

  await github.editReleaseBody(tag, `${kept}\n\n${telegramLine(links)}`);
  out(`✓ ${tag}: recorded the Telegram links of ${chats.join(", ")}`);
}

function printPost(chat, post) {
  return post.method === "sendMessage"
    ? `${chat} · sendMessage\n${post.text}\n`
    : `${chat} · sendAnimation · ${post.animation} · reply to the opening\n${post.caption}\n`;
}

function parseAnswer(text) {
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
}

const unsure = (message, cause) =>
  Object.assign(new Error(message, { cause }), { uncertain: true });

async function reach({ fetch, token, method, chat }, init) {
  try {
    return await fetch(`${TELEGRAM_API}/bot${token}/${method}`, init);
  } catch (error) {
    throw unsure(
      `could not reach Telegram for ${method} to ${chat}: ${messageOf(error)}`,
      error,
    );
  }
}

async function answerOf(response, { method, chat }) {
  try {
    return parseAnswer(await response.text());
  } catch (error) {
    throw unsure(
      `could not read the answer of Telegram to ${method} for ${chat}: ${messageOf(error)}`,
      error,
    );
  }
}

async function callTelegram(request, init, retry = 0) {
  const response = await reach(request, init);
  const answer = await answerOf(response, request);

  if (response.ok && answer.ok === true) {
    return answer.result;
  }

  const retryAfter = answer.parameters?.retry_after;

  if (
    response.status === 429 &&
    typeof retryAfter === "number" &&
    retry < ANNOUNCE_RETRIES
  ) {
    await request.sleep(retryAfter * 1000);
    return callTelegram(request, init, retry + 1);
  }

  const message = `Telegram answered ${response.status} to ${request.method} for ${request.chat}: ${answer.description ?? response.statusText}`;

  throw response.ok ? unsure(message) : new Error(message);
}

function openingIdOf(result, chat) {
  const messageId = result?.message_id;

  if (typeof messageId !== "number") {
    throw unsure(
      `Telegram answered the opening of ${chat} without a message_id, so its GIFs cannot reply to it`,
    );
  }

  return messageId;
}

const jsonRequest = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const releaseLinkOf = (repository) =>
  `https://github.com/${repository}/releases/tag/v`;

function openingVersionOf(message, repository) {
  const link = releaseLinkOf(repository);

  return (message?.entities ?? [])
    .filter(
      ({ type, url }) =>
        type === "text_link" && typeof url === "string" && url.startsWith(link),
    )
    .map(({ url }) => url.slice(link.length))
    .findLast(isVersion);
}

async function pinOpening(target, { openingId, repository, version }) {
  const chat = await callTelegram(
    { ...target, method: "getChat" },
    jsonRequest({ chat_id: target.destination }),
  );
  const pinned = chat?.pinned_message;

  if (pinned?.message_id === openingId) {
    return null;
  }

  const pinnedVersion = openingVersionOf(pinned, repository);

  if (
    pinnedVersion !== undefined &&
    compareVersions(pinnedVersion, version) > 0
  ) {
    return pinnedVersion;
  }

  if (pinnedVersion !== undefined) {
    await callTelegram(
      { ...target, method: "unpinChatMessage" },
      jsonRequest({
        chat_id: target.destination,
        message_id: pinned.message_id,
      }),
    );
  }

  await callTelegram(
    { ...target, method: "pinChatMessage" },
    jsonRequest({
      chat_id: target.destination,
      message_id: openingId,
      disable_notification: true,
    }),
  );

  return null;
}

function requestOf({ destination, prefix, media }, post, openingId) {
  if (post.method === "sendMessage") {
    return jsonRequest({
      chat_id: destination,
      text: `${prefix}${post.text}`,
      parse_mode: "HTML",
    });
  }

  const form = new FormData();

  form.set("chat_id", destination);
  form.set("caption", `${prefix}${post.caption}`);
  form.set("parse_mode", "HTML");
  form.set("reply_parameters", JSON.stringify({ message_id: openingId }));
  form.set(
    "animation",
    new Blob([media.get(post.animation)], { type: post.contentType }),
    post.fileName,
  );

  return { method: "POST", body: form };
}

const prefixOf = (chat, dryRun) => (dryRun ? `[${chat}]\n` : "");

function checkDryRunLimits(announcements) {
  for (const { chat, posts } of announcements) {
    for (const post of posts) {
      const opening = post.method === "sendMessage";
      const length = visibleLength(
        `${prefixOf(chat, true)}${opening ? post.text : post.caption}`,
      );
      const limit = opening ? MESSAGE_LIMIT : CAPTION_LIMIT;

      if (length > limit) {
        throw new Error(
          `the dry run of ${chat} makes ${opening ? "an opening" : "a caption"} of ${length} characters, over the ${limit} Telegram takes`,
        );
      }
    }
  }
}

async function fetchAnimation(fetch, url, chat) {
  try {
    return await fetch(url);
  } catch (error) {
    throw new Error(
      `could not download the animation ${url} for ${chat}: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

async function download(fetch, url, chat) {
  const response = await fetchAnimation(fetch, url, chat);

  if (!response.ok) {
    throw new Error(
      `could not download the animation ${url} for ${chat}: ${response.status}`,
    );
  }

  const bytes = await response.arrayBuffer();

  if (bytes.byteLength > ANIMATION_LIMIT_BYTES) {
    throw new Error(
      `the animation ${url} for ${chat} has ${bytes.byteLength} bytes, over the ${ANIMATION_LIMIT_BYTES} Telegram takes`,
    );
  }

  return [url, bytes];
}

async function downloadAnimations(fetch, announcements) {
  const firstChatOf = new Map();

  for (const { chat, posts } of announcements) {
    for (const { animation } of posts) {
      if (animation !== undefined && !firstChatOf.has(animation)) {
        firstChatOf.set(animation, chat);
      }
    }
  }

  return new Map(
    await Promise.all(
      [...firstChatOf].map(([url, chat]) => download(fetch, url, chat)),
    ),
  );
}

function resumeEntry(entry, postsOf) {
  const match = RESUME_ENTRY.exec(entry);

  if (match === null) {
    throw new Error(`ANNOUNCE_RESUME: "${entry}" is not ${RESUME_FORMAT}`);
  }

  const [, chat, openingId, sent] = match;
  const total = postsOf.get(chat);

  if (total === undefined) {
    throw new Error(
      `ANNOUNCE_RESUME: ${chat} is not a channel of this version`,
    );
  }

  if (openingId === undefined) {
    return [chat, { done: true, openingId: null, sent: total }];
  }

  const count = Number(sent);

  if (count < 1 || count > total) {
    throw new Error(
      `ANNOUNCE_RESUME: ${chat} has ${total} posts, so ${count} cannot be left to post`,
    );
  }

  return [chat, { done: false, openingId: Number(openingId), sent: count }];
}

const destinationOf = (testChannel) =>
  testChannel === null ? "the public channels" : `a dry run in ${testChannel}`;

function cursorHeader({ version, testChannel }) {
  return [
    `v${version}`,
    ...(testChannel === null ? [] : [`${RESUME_TEST}${testChannel}`]),
  ];
}

function parseResume(text, announcements, cursor) {
  const entries = text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (entries.length === 0) {
    return new Map();
  }

  const [version, ...rest] = entries;

  if (!version.startsWith("v")) {
    throw new Error(
      `ANNOUNCE_RESUME: the cursor does not start with the version, v${cursor.version}`,
    );
  }

  if (version !== `v${cursor.version}`) {
    throw new Error(
      `ANNOUNCE_RESUME: the cursor is of ${version}, not of v${cursor.version}`,
    );
  }

  const cursorTest = rest[0]?.startsWith(RESUME_TEST)
    ? rest[0].slice(RESUME_TEST.length)
    : null;

  if (cursorTest !== cursor.testChannel) {
    throw new Error(
      `ANNOUNCE_RESUME: the cursor is of ${destinationOf(cursorTest)}, not of ${destinationOf(cursor.testChannel)}`,
    );
  }

  const postsOf = new Map(
    announcements.map(({ chat, posts }) => [chat, posts.length]),
  );

  return new Map(
    rest
      .slice(cursorTest === null ? 0 : 1)
      .map((entry) => resumeEntry(entry, postsOf)),
  );
}

function withResume(error, { cursor, finished }, { chat, openingId, sent }) {
  const resumeOf = (entries) => [...cursorHeader(cursor), ...entries].join(",");
  const done = finished.map((channel) => `${channel}=done`);
  const notShown = [
    ...done,
    ...(openingId === null ? [] : [`${chat}=${openingId}:${sent}`]),
  ];

  if (error.uncertain !== true) {
    return notShown.length === 0
      ? error
      : new Error(
          `${messageOf(error)}; to post only what is left, dispatch announce-release.yml with resume: ${resumeOf(notShown)}`,
          { cause: error },
        );
  }

  const shown = [...done, `${chat}=${openingId ?? OPENING_ID}:${sent + 1}`];
  const hint = openingId === null ? ` (${OPENING_ID_HINT})` : "";
  const ifNot =
    notShown.length === 0
      ? "run the announcement again"
      : `resume: ${resumeOf(notShown)}`;
  const where =
    cursor.testChannel === null
      ? chat
      : `${cursor.testChannel} under [${chat}]`;

  return new Error(
    `${messageOf(error)}; Telegram may have taken it: if it shows in ${where}, dispatch announce-release.yml with resume: ${resumeOf(shown)}${hint}; if not, ${ifNot}`,
    { cause: error },
  );
}

async function postAnnouncements(
  announcements,
  { env, fetch, sleep, out, token, repository, record },
) {
  if (token === "") {
    throw new Error(
      "TELEGRAM_ANNOUNCE_TOKEN is required to post; --print shows the posts without it",
    );
  }

  const dryRun = env.DRY_RUN === "1";
  const testChannel = env.TELEGRAM_TEST_CHANNEL ?? "";

  if (dryRun && testChannel === "") {
    throw new Error(
      "DRY_RUN=1 posts to TELEGRAM_TEST_CHANNEL, which is not set",
    );
  }

  if (dryRun) {
    checkDryRunLimits(announcements);
  }

  const cursor = {
    version: env.VERSION,
    testChannel: dryRun ? testChannel : null,
  };
  const resume = parseResume(env.ANNOUNCE_RESUME ?? "", announcements, cursor);
  const pending = announcements.map(({ chat, posts }) => {
    const from = resume.get(chat) ?? { done: false, openingId: null, sent: 0 };

    return {
      chat,
      done: from.done,
      openingId: from.openingId,
      sent: from.sent,
      total: posts.length,
      posts: from.done ? [] : posts.slice(from.sent),
    };
  });
  const media = await downloadAnimations(fetch, pending);
  const postedTo = new Set();
  const finished = [];
  const openings = {};
  const noteOpening = (chat, openingId) => {
    if (!dryRun) {
      openings[chat] = openingId;
      record({ ...openings });
    }
  };

  for (const { chat, done, posts, total, ...progress } of pending) {
    if (done) {
      finished.push(chat);
      out(`✓ ${chat}: posted before`);
      continue;
    }

    const destination = dryRun ? testChannel : chat;
    const target = {
      fetch,
      sleep,
      token,
      chat,
      destination,
      prefix: prefixOf(chat, dryRun),
      media,
    };

    let { openingId, sent } = progress;

    if (openingId !== null) {
      noteOpening(chat, openingId);
    }

    for (const item of posts) {
      const init = requestOf(target, item, openingId);

      if (postedTo.has(destination)) {
        await sleep(ANNOUNCE_PAUSE_MS);
      }

      const postedId = await callTelegram(
        { ...target, method: item.method },
        init,
      )
        .then((result) =>
          item.method === "sendMessage" ? openingIdOf(result, chat) : null,
        )
        .catch((error) => {
          throw withResume(
            error,
            { cursor, finished },
            { chat, openingId, sent },
          );
        });

      postedTo.add(destination);
      sent += 1;
      openingId = postedId ?? openingId;

      if (postedId !== null) {
        noteOpening(chat, postedId);
      }
    }

    const newerPinned = await pinOpening(target, {
      openingId,
      repository,
      version: cursor.version,
    }).catch((error) => {
      throw withResume(
        new Error(messageOf(error), { cause: error }),
        { cursor, finished },
        { chat, openingId, sent: total },
      );
    });
    const pinStatus =
      newerPinned === null
        ? "opening pinned"
        : `opening kept, v${newerPinned} is pinned`;

    finished.push(chat);
    out(
      posts.length === 0
        ? `✓ ${chat}: ${pinStatus}`
        : `✓ ${chat}: ${posts.length} ${posts.length === 1 ? "post" : "posts"}${dryRun ? ` in ${testChannel}` : ""}, ${pinStatus}`,
    );
  }
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === "link") {
    return { link: true };
  }

  const options = { link: false, print: false, root: "." };
  const queue = [...args];

  while (queue.length > 0) {
    const arg = queue.shift();

    if (arg === "--print") {
      options.print = true;
    } else if (arg === "--root" && queue.length > 0) {
      options.root = queue.shift();
    } else {
      return null;
    }
  }

  return options;
}

const redact = (text, token) =>
  token === "" ? text : text.replaceAll(token, "***");

export async function run(
  args,
  { root, env, fetch, sleep, out, err, github, record },
) {
  const options = parseArgs(args);

  if (options === null) {
    err(USAGE);
    return 2;
  }

  const token = env.TELEGRAM_ANNOUNCE_TOKEN ?? "";

  try {
    const version = env.VERSION ?? "";

    if (version === "") {
      throw new Error("VERSION is required");
    }

    const repository = env.GH_REPO || REPOSITORY;
    const releases = github ?? ghGithub(repository);

    if (options.link) {
      await linkOpenings({ version, env, github: releases, out });
      return 0;
    }

    const base = resolve(root, options.root);
    const records = options.print
      ? {}
      : await readRecords(releases, gatheredOf(base, version));
    const announcements = buildAnnouncements({
      root: base,
      version,
      repository,
      records,
    });

    if (options.print) {
      for (const { chat, posts } of announcements) {
        for (const item of posts) {
          out(printPost(chat, item));
        }
      }
    } else {
      await postAnnouncements(announcements, {
        env,
        fetch,
        sleep,
        out,
        token,
        repository,
        record: record ?? recordToGithubOutput(env),
      });
    }

    return 0;
  } catch (error) {
    err(`✗ ${redact(messageOf(error), token)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), {
    root: join(import.meta.dirname, ".."),
    env: process.env,
    fetch,
    sleep: (ms) => delay(ms),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
