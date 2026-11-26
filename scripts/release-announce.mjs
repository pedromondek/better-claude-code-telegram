import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  COMMAND,
  REPOSITORY,
  SETUP_COMMAND,
} from "../npm/shim/shim.constants.mjs";
import { PORTUGUESE_BLOCK } from "./release-notes-layout.mjs";
import { distTagOf } from "./release-npm-publish.mjs";
import { notesPath } from "./release-pr.mjs";
import {
  ANNOUNCE_CHANNELS,
  ANNOUNCE_PAUSE_MS,
  ANNOUNCE_RETRIES,
  TELEGRAM_API,
} from "./release.constants.mjs";
import { parseVersion } from "./version.mjs";

const USAGE =
  "usage: npm run release:announce -- [--print] [--root <folder>] (version in VERSION)";
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
const PRERELEASE_NOTES = /^(?:alpha|beta|rc)\.\d+\.md$/u;
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
  "en-us": { notes: "Release notes", install: "Install", stable: "is stable" },
  "pt-br": {
    notes: "Notas da versão",
    install: "Instalar",
    stable: "está estável",
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

function newFeatures(root, version, features) {
  const file = notesPath(version);
  const folder = dirname(file);
  const seen = readdirSync(join(root, folder))
    .filter((name) => PRERELEASE_NOTES.test(name))
    .flatMap(
      (name) =>
        parseNotes(
          readFileSync(join(root, folder, name), "utf8"),
          join(folder, name),
        )["en-us"].features,
    );
  const seenUrls = (key) =>
    new Set(seen.map((item) => item[key]).filter((url) => url !== null));
  const seenGifs = seenUrls("gif");
  const seenVideos = seenUrls("video");
  const seenTexts = new Set(seen.map(({ text }) => normalizedText(text)));

  return features.map(
    ({ text, gif, video }) =>
      !seenGifs.has(gif) &&
      !seenVideos.has(video) &&
      !seenTexts.has(normalizedText(text)),
  );
}

function openingText({ marker, title, bullets, language, context }) {
  const { version, repository, tag } = context;
  const wording = WORDING[language];

  return [
    `${marker} ${title}`,
    "",
    ...(bullets.length > 0
      ? [...bullets.map((bullet) => `• ${toTelegramHtml(bullet)}`), ""]
      : []),
    `<a href="https://github.com/${repository}/releases/tag/v${version}">${wording.notes}</a>`,
    `${wording.install}: <code>${escapeHtml(`${SETUP_COMMAND}@${tag}`)}</code>`,
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

function fullAnnouncement(channel, notes, marker, context) {
  const { summary, features } = notes[channel.language];

  return announcement(channel, {
    opening: openingText({
      marker,
      title: `<b>${COMMAND} ${context.version}</b>`,
      bullets: summary,
      language: channel.language,
      context,
    }),
    features,
  });
}

function stableNewsAnnouncement(channel, notes, fresh, context) {
  const features = notes[channel.language].features.filter(
    (_feature, index) => fresh[index],
  );

  return announcement(channel, {
    opening: openingText({
      marker: "✅",
      title: `<b>${context.version}</b> ${WORDING[channel.language].stable}`,
      bullets: features.map(({ text }) => withoutSparkle(text)),
      language: channel.language,
      context,
    }),
    features,
  });
}

export function buildAnnouncements({ root, version, repository }) {
  const notes = readNotes(root, version);
  const context = { version, repository, tag: distTagOf(version) };

  if (parseVersion(version).stage !== null) {
    return ANNOUNCE_CHANNELS.prereleases.map((channel) =>
      fullAnnouncement(channel, notes, "🧪", context),
    );
  }

  const fresh = newFeatures(root, version, notes["en-us"].features);

  return [
    ...ANNOUNCE_CHANNELS.stable.map((channel) =>
      fullAnnouncement(channel, notes, "🚀", context),
    ),
    ...ANNOUNCE_CHANNELS.prereleases.map((channel) =>
      stableNewsAnnouncement(channel, notes, fresh, context),
    ),
  ];
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

function requestOf({ destination, prefix, media }, post, openingId) {
  if (post.method === "sendMessage") {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: destination,
        text: `${prefix}${post.text}`,
        parse_mode: "HTML",
      }),
    };
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

  if (count < 1 || count >= total) {
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

function withResume(
  error,
  { cursor, finished },
  { chat, openingId, sent, total },
) {
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

  const shown = [
    ...done,
    sent + 1 === total
      ? `${chat}=done`
      : `${chat}=${openingId ?? OPENING_ID}:${sent + 1}`,
  ];
  const hint =
    openingId === null && sent + 1 < total ? ` (${OPENING_ID_HINT})` : "";
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
  { env, fetch, sleep, out, token },
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
            { chat, openingId, sent, total },
          );
        });

      postedTo.add(destination);
      sent += 1;
      openingId = postedId ?? openingId;
    }

    finished.push(chat);
    out(
      `✓ ${chat}: ${posts.length} ${posts.length === 1 ? "post" : "posts"}${dryRun ? ` in ${testChannel}` : ""}`,
    );
  }
}

function parseArgs(args) {
  const options = { print: false, root: "." };
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

export async function run(args, { root, env, fetch, sleep, out, err }) {
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

    const announcements = buildAnnouncements({
      root: resolve(root, options.root),
      version,
      repository: env.GH_REPO || REPOSITORY,
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
