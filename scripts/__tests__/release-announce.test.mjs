import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildAnnouncements,
  ghGithub,
  parseNotes,
  parseTelegramLine,
  run,
  telegramLine,
  toTelegramHtml,
} from "../release-announce.mjs";
import {
  BLOCK_END,
  ENGLISH_BLOCK,
  PORTUGUESE_BLOCK,
  followAlert,
  installAlert,
  legendAlert,
  updateAlert,
} from "../release-notes-layout.mjs";
import { ANNOUNCE_CHANNELS } from "../release.constants.mjs";

const [STABLE_EN, STABLE_PT] = ANNOUNCE_CHANNELS.stable.map(({ chat }) => chat);
const [PRE_EN, PRE_PT] = ANNOUNCE_CHANNELS.prereleases.map(({ chat }) => chat);

const ROOT = join(import.meta.dirname, "..", "..");
const REPO = "owner/repo";
const TOKEN = "123456:TEST";
const TEST_CHANNEL = "@bcct_test";
const PRERELEASE = "0.3.0-alpha.1";
const STABLE = "0.3.0";
const PRERELEASE_FILE = "docs/releases/0.3.0/alpha.1.md";
const STABLE_FILE = "docs/releases/0.3.0/stable.md";
const GIF_A = "https://github.com/user-attachments/assets/aaa";
const GIF_B = "https://github.com/user-attachments/assets/bbb";
const GIF_C = "https://github.com/user-attachments/assets/ccc";
const VIDEO_A = "https://github.com/user-attachments/assets/vaa";
const VIDEO_C = "https://github.com/user-attachments/assets/vcc";
const VIDEO_PT = "https://github.com/user-attachments/assets/vpt";
const NO_EXTRAS = { paragraphs: [] };
const API = `https://api.telegram.org/bot${TOKEN}`;
const UNSURE_FIRST_OPENING = `; Telegram may have taken it: if it shows in ${PRE_EN}, dispatch announce-release.yml with resume: v${PRERELEASE},${PRE_EN}=<opening id>:1 (the opening id is the number at the end of its t.me link); if not, run the announcement again`;

const QUESTIONS = {
  en: "Questions arrive with **buttons** & `options`.",
  pt: "As perguntas chegam com **botões** & `opções`.",
  gif: GIF_A,
};
const NOTICE = {
  en: "A notice tells you when Claude waits, see [the docs](https://example.com/docs?a=1&b=2).",
  pt: "Um aviso diz quando o Claude espera, veja [a doc](https://example.com/docs?a=1&b=2).",
  gif: null,
};
const UPDATE = {
  en: "`bcct update` updates everything.",
  pt: "`bcct update` atualiza tudo.",
  gif: GIF_B,
};
const VOICE = {
  en: "Voice messages are **transcribed**.",
  pt: "Mensagens de voz são **transcritas**.",
  gif: GIF_C,
};
const PRERELEASE_FEATURES = [QUESTIONS, NOTICE, UPDATE];
const STABLE_FEATURES = [QUESTIONS, NOTICE, UPDATE, VOICE];

function itemLines(text, gif, video = null) {
  return [
    `- ✨ ${text}`,
    ...(gif === null ? [] : ["", `  ![demo](${gif})`]),
    ...(video === null ? [] : [`  <!-- telegram: ${video} -->`]),
  ];
}

function notesText({
  features = PRERELEASE_FEATURES,
  summaryEn = [
    "**Buttons** answer the questions of Claude.",
    "The setup is faster.",
  ],
  summaryPt = [
    "**Botões** respondem às perguntas do Claude.",
    "O setup ficou mais rápido.",
  ],
  ptFeatures = features,
} = {}) {
  const [firstEn, ...restEn] = features;
  const [firstPt, ...restPt] = ptFeatures;

  return [
    "### 📋 Summary",
    ...summaryEn.map((line) => `- ${line}`),
    "",
    "✨ new · 🐛 fix",
    "",
    "### 💬 Telegram channel",
    ...(firstEn === undefined
      ? []
      : itemLines(firstEn.en, firstEn.gif, firstEn.video)),
    "- 🐛 A fix.",
    "  ![fix](https://github.com/user-attachments/assets/fix)",
    ...restEn.flatMap((item) => itemLines(item.en, item.gif, item.video)),
    "",
    "<details><summary>🇧🇷 Português</summary>",
    "",
    "### 📋 Resumo",
    ...summaryPt.map((line) => `- ${line}`),
    "",
    "✨ novo · 🐛 correção",
    "",
    "### 💬 Canal do Telegram",
    ...(firstPt === undefined
      ? []
      : itemLines(firstPt.pt, null, firstPt.ptVideo ?? null)),
    "- 🐛 Uma correção.",
    ...restPt.flatMap((item) => itemLines(item.pt, null, item.ptVideo ?? null)),
    "",
    "</details>",
    "",
  ].join("\n");
}

function collapsedNotesText() {
  const open = notesText();
  const start = open.indexOf(PORTUGUESE_BLOCK);
  const english = open
    .slice(0, start)
    .replace("\n✨ new · 🐛 fix\n", "")
    .trim();
  const portuguese = open
    .slice(start)
    .replace("\n✨ novo · 🐛 correção\n", "")
    .replace(
      `- ✨ ${QUESTIONS.pt}`,
      `- ✨ ${QUESTIONS.pt}\n\n  ![Botões](${QUESTIONS.gif})`,
    );

  return [
    followAlert(),
    "",
    installAlert(PRERELEASE),
    "",
    updateAlert(PRERELEASE),
    "",
    legendAlert(),
    "",
    ENGLISH_BLOCK,
    "",
    english,
    "",
    BLOCK_END,
    "",
    portuguese,
  ].join("\n");
}

function tempRoot(files = { [PRERELEASE_FILE]: notesText() }) {
  const root = mkdtempSync(join(tmpdir(), "announce-"));

  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }

  return root;
}

function stableFiles(extra = {}) {
  return {
    [STABLE_FILE]: notesText({ features: STABLE_FEATURES }),
    [PRERELEASE_FILE]: notesText({
      features: [
        { en: "Questions come with buttons.", pt: "Perguntas.", gif: GIF_A },
        NOTICE,
      ],
    }),
    "docs/releases/0.3.0/beta.1.md": notesText({
      features: [
        {
          en: "  `BCCT update`    updates EVERYTHING. ",
          pt: "Atualiza.",
          gif: GIF_B,
        },
      ],
    }),
    "docs/releases/0.3.0/draft.md": notesText({ features: [VOICE] }),
    ...extra,
  };
}

const releaseLink = (version) =>
  `https://github.com/${REPO}/releases/tag/v${version}`;

function includesLines(includes, language) {
  if (includes.length === 0) {
    return [];
  }

  return [
    language === "en-us" ? "Includes:" : "Inclui:",
    ...includes.flatMap(({ version, telegram = null }) => [
      `• v${version}`,
      `   ${telegram === null ? "" : `<a href="${telegram}">📣 Telegram</a> · `}<a href="${releaseLink(version)}">🔗 Release</a>`,
    ]),
    "",
  ];
}

function opening({
  marker,
  title,
  bullets,
  version,
  language,
  tag,
  includes = [],
}) {
  const english = language === "en-us";

  return [
    `${marker} <b>${title}</b>`,
    "",
    ...(bullets.length > 0 ? [...bullets, ""] : []),
    ...includesLines(includes, language),
    `<a href="${releaseLink(version)}">📝 ${english ? "Release notes" : "Notas da versão"}</a>`,
    `${english ? "Install" : "Instalar"}: <code>npx @pedromondek/better-claude-code-telegram${tag === null ? "" : `@${tag}`}</code>`,
  ].join("\n");
}

const STABLE_INCLUDES = [
  { version: "0.3.0-alpha.1" },
  { version: "0.3.0-beta.1" },
];

const EN_SUMMARY = [
  "• <b>Buttons</b> answer the questions of Claude.",
  "• The setup is faster.",
];
const PT_SUMMARY = [
  "• <b>Botões</b> respondem às perguntas do Claude.",
  "• O setup ficou mais rápido.",
];
const EN_CAPTIONS = {
  [GIF_A]: "Questions arrive with <b>buttons</b> &amp; <code>options</code>.",
  [GIF_B]: "<code>bcct update</code> updates everything.",
  [GIF_C]: "Voice messages are <b>transcribed</b>.",
};
const PT_CAPTIONS = {
  [GIF_A]: "As perguntas chegam com <b>botões</b> &amp; <code>opções</code>.",
  [GIF_B]: "<code>bcct update</code> atualiza tudo.",
  [GIF_C]: "Mensagens de voz são <b>transcritas</b>.",
};

const animations = (captions, gifs) =>
  gifs.map((gif) => ({
    method: "sendAnimation",
    caption: captions[gif],
    animation: gif,
    contentType: "image/gif",
    fileName: "animation.gif",
  }));

const PRERELEASE_ANNOUNCEMENTS = [
  {
    chat: PRE_EN,
    language: "en-us",
    posts: [
      {
        method: "sendMessage",
        text: opening({
          marker: "🧪",
          title: `better-claude-code-telegram ${PRERELEASE}`,
          bullets: EN_SUMMARY,
          version: PRERELEASE,
          language: "en-us",
          tag: "alpha",
        }),
      },
      ...animations(EN_CAPTIONS, [GIF_A, GIF_B]),
    ],
  },
  {
    chat: PRE_PT,
    language: "pt-br",
    posts: [
      {
        method: "sendMessage",
        text: opening({
          marker: "🧪",
          title: `better-claude-code-telegram ${PRERELEASE}`,
          bullets: PT_SUMMARY,
          version: PRERELEASE,
          language: "pt-br",
          tag: "alpha",
        }),
      },
      ...animations(PT_CAPTIONS, [GIF_A, GIF_B]),
    ],
  },
];

const sentWithId = (count) => ({
  status: 200,
  body: { ok: true, result: { message_id: 100 + count } },
});

const PIN_METHODS = new Set(["getChat", "unpinChatMessage", "pinChatMessage"]);
const methodOf = (url) => url.slice(url.lastIndexOf("/") + 1);
const isPost = (url) =>
  url.startsWith("https://api.telegram.org/") &&
  !PIN_METHODS.has(methodOf(url));
const nothingPinned = (method) => ({
  status: 200,
  body: { ok: true, result: method === "getChat" ? { id: -100 } : true },
});
const pinnedIn = (pinned) => (method) =>
  method === "getChat"
    ? { status: 200, body: { ok: true, result: { id: -100, ...pinned } } }
    : nothingPinned(method);
const openingOf = (messageId, version = "0.2.0") => ({
  pinned_message: {
    message_id: messageId,
    text: `🧪 better-claude-code-telegram ${version}`,
    entities: [
      {
        type: "text_link",
        offset: 0,
        length: 13,
        url: `https://github.com/${REPO}/releases/tag/v${version}`,
      },
    ],
  },
});

function fakeFetch({
  telegram = sentWithId,
  pinning = nothingPinned,
  gifStatus = () => 200,
  gifBody = (url) => `bytes of ${url}`,
  failWith = null,
  failOn = () => true,
} = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });

    if (failWith !== null && failOn(url)) {
      throw failWith;
    }

    if (url.startsWith("https://api.telegram.org/")) {
      const answer = isPost(url)
        ? telegram(calls.filter((call) => isPost(call.url)).length)
        : pinning(methodOf(url), JSON.parse(init.body));

      if (answer.bodyError !== undefined) {
        return new Response(
          new ReadableStream({
            start: (controller) => controller.error(answer.bodyError),
          }),
          { status: answer.status },
        );
      }

      return new Response(
        typeof answer.body === "string"
          ? answer.body
          : JSON.stringify(answer.body),
        { status: answer.status, statusText: answer.statusText ?? "" },
      );
    }

    const status = gifStatus(url);

    return new Response(status === 200 ? gifBody(url) : "missing", {
      status,
    });
  };

  return { fetch, calls };
}

function fakeSleep() {
  const sleeps = [];

  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

function fakeGithub({ bodies = {}, failOn = null } = {}) {
  const reads = [];
  const edits = [];

  return {
    reads,
    edits,
    releaseBody: async (tag) => {
      reads.push(tag);

      if (failOn === "read") {
        throw new Error("gh is down");
      }

      return Object.hasOwn(bodies, tag) ? bodies[tag] : null;
    },
    editReleaseBody: async (tag, body) => {
      edits.push({ tag, body });

      if (failOn === "edit") {
        throw new Error("gh refused the edit");
      }
    },
  };
}

async function announceWith({
  args = [],
  env = {},
  root = tempRoot(),
  fetch: fetchOptions = {},
  github = fakeGithub(),
  record = undefined,
} = {}) {
  const clock = fakeSleep();
  const { fetch, calls } = fakeFetch(fetchOptions);
  const out = [];
  const err = [];
  const recorded = [];
  const code = await run(args, {
    root,
    env: {
      VERSION: PRERELEASE,
      GH_REPO: REPO,
      TELEGRAM_ANNOUNCE_TOKEN: TOKEN,
      ...env,
    },
    fetch,
    sleep: clock.sleep,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    github,
    record: record === null ? undefined : (openings) => recorded.push(openings),
  });

  return { code, out, err, calls, sleeps: clock.sleeps, github, recorded };
}

const telegramCalls = (calls) =>
  calls.filter((call) => call.url.startsWith("https://api.telegram.org/"));

const pinCalls = (calls) =>
  telegramCalls(calls)
    .filter(({ url }) => !isPost(url))
    .map(({ url, init }) => {
      const body = JSON.parse(init.body);

      return {
        method: methodOf(url),
        chat: body.chat_id,
        messageId: body.message_id,
        disableNotification: body.disable_notification,
      };
    });

async function sentPosts(calls) {
  const posts = [];

  for (const { url, init } of telegramCalls(calls).filter((call) =>
    isPost(call.url),
  )) {
    const method = url.slice(url.lastIndexOf("/") + 1);

    if (init.body instanceof FormData) {
      const animation = init.body.get("animation");

      posts.push({
        url,
        method,
        chat: init.body.get("chat_id"),
        caption: init.body.get("caption"),
        parseMode: init.body.get("parse_mode"),
        replyParameters: JSON.parse(init.body.get("reply_parameters")),
        animation: {
          type: animation.type,
          name: animation.name,
          bytes: await animation.text(),
        },
      });
    } else {
      const body = JSON.parse(init.body);

      posts.push({
        url,
        method,
        chat: body.chat_id,
        text: body.text,
        parseMode: body.parse_mode,
        replyParameters: body.reply_parameters,
        contentType: init.headers["content-type"],
      });
    }
  }

  return posts;
}

describe("release-announce › toTelegramHtml", () => {
  it("escapes &, < and > before turning bold, code and links into tags", () => {
    expect(
      toTelegramHtml(
        "a < b & c > d **bold** `code` [text](https://x.test/?a=1&b=2)",
      ),
    ).toBe(
      'a &lt; b &amp; c &gt; d <b>bold</b> <code>code</code> <a href="https://x.test/?a=1&amp;b=2">text</a>',
    );
  });

  it("keeps a tag typed in the notes as text", () => {
    expect(toTelegramHtml("<script>x</script>")).toBe(
      "&lt;script&gt;x&lt;/script&gt;",
    );
  });

  it("escapes a double quote of a link URL inside the href", () => {
    expect(toTelegramHtml('[t](https://x.test/"y)')).toBe(
      '<a href="https://x.test/&quot;y">t</a>',
    );
  });

  it("keeps the balanced parentheses of a link URL inside its href", () => {
    expect(
      toTelegramHtml(
        "see [guide](https://example.com/Guide_(setup)) and [x](https://x.test) (stable)",
      ),
    ).toBe(
      'see <a href="https://example.com/Guide_(setup)">guide</a> and <a href="https://x.test">x</a> (stable)',
    );
  });

  it("keeps the bold and link Markdown inside a code span as literal text", () => {
    expect(
      toTelegramHtml("Ignore `**/node_modules/**` and `[a](https://x.test)`"),
    ).toBe(
      "Ignore <code>**/node_modules/**</code> and <code>[a](https://x.test)</code>",
    );
  });

  it("keeps a code span inside bold or a link as plain text, since Telegram nests no code there", () => {
    expect(
      toTelegramHtml(
        "**Use `bcct` now** [`x`](https://x.test) **see [`y`](https://y.test)** `z`",
      ),
    ).toBe(
      '<b>Use bcct now</b> <a href="https://x.test">x</a> <b>see <a href="https://y.test">y</a></b> <code>z</code>',
    );
  });
});

describe("release-announce › notes", () => {
  it("reads the summary and the ✨ items of each language, with the GIF of the en-us item on both", () => {
    expect(parseNotes(notesText(), PRERELEASE_FILE)).toEqual({
      "en-us": {
        summary: [
          "**Buttons** answer the questions of Claude.",
          "The setup is faster.",
        ],
        features: [
          { text: `✨ ${QUESTIONS.en}`, gif: GIF_A, video: null, ...NO_EXTRAS },
          { text: `✨ ${NOTICE.en}`, gif: null, video: null, ...NO_EXTRAS },
          { text: `✨ ${UPDATE.en}`, gif: GIF_B, video: null, ...NO_EXTRAS },
        ],
      },
      "pt-br": {
        summary: [
          "**Botões** respondem às perguntas do Claude.",
          "O setup ficou mais rápido.",
        ],
        features: [
          { text: `✨ ${QUESTIONS.pt}`, gif: GIF_A, video: null, ...NO_EXTRAS },
          { text: `✨ ${NOTICE.pt}`, gif: null, video: null, ...NO_EXTRAS },
          { text: `✨ ${UPDATE.pt}`, gif: GIF_B, video: null, ...NO_EXTRAS },
        ],
      },
    });
  });

  it("takes as the GIF the first image line indented under the item, after blank lines", () => {
    const text = notesText().replace(
      `- ✨ ${NOTICE.en}`,
      `- ✨ ${NOTICE.en}\n\n\n  ![late](${GIF_C})\n  ![second](${GIF_A})`,
    );

    expect(parseNotes(text, PRERELEASE_FILE)["en-us"].features[1]).toEqual({
      text: `✨ ${NOTICE.en}`,
      gif: GIF_C,
      video: null,
      ...NO_EXTRAS,
    });
  });

  it("takes the MP4 of the telegram comment under the item, after the image line, on both languages", () => {
    const text = notesText().replace(
      `- ✨ ${NOTICE.en}`,
      `- ✨ ${NOTICE.en}\n\n  ![demo](${GIF_C})\n  <!-- telegram: ${VIDEO_C} -->`,
    );
    const notes = parseNotes(text, PRERELEASE_FILE);

    expect(notes["en-us"].features[1]).toEqual({
      text: `✨ ${NOTICE.en}`,
      gif: GIF_C,
      video: VIDEO_C,
      ...NO_EXTRAS,
    });
    expect(notes["pt-br"].features[1]).toEqual({
      text: `✨ ${NOTICE.pt}`,
      gif: GIF_C,
      video: VIDEO_C,
      ...NO_EXTRAS,
    });
  });

  it("leaves the MP4 out of an item when the telegram comment comes after the next bullet", () => {
    const text = notesText().replace(
      `- ✨ ${NOTICE.en}`,
      `- ✨ ${NOTICE.en}\n\n- 🐛 Other.\n\n  <!-- telegram: ${VIDEO_C} -->`,
    );

    expect(parseNotes(text, PRERELEASE_FILE)["en-us"].features[1]).toEqual({
      text: `✨ ${NOTICE.en}`,
      gif: null,
      video: null,
      ...NO_EXTRAS,
    });
  });

  it("leaves the GIF out of an item when the image line comes after the next bullet", () => {
    const text = notesText().replace(
      `- ✨ ${NOTICE.en}`,
      `- ✨ ${NOTICE.en}\n\n- 🐛 Other.\n\n  ![other](${GIF_C})`,
    );

    expect(parseNotes(text, PRERELEASE_FILE)["en-us"].features[1]).toEqual({
      text: `✨ ${NOTICE.en}`,
      gif: null,
      video: null,
      ...NO_EXTRAS,
    });
  });

  it("takes no GIF from an image line indented by a single space", () => {
    const text = notesText().replace(
      `- ✨ ${NOTICE.en}`,
      `- ✨ ${NOTICE.en}\n\n ![one](${GIF_C})`,
    );

    expect(parseNotes(text, PRERELEASE_FILE)["en-us"].features[1].gif).toBe(
      null,
    );
  });

  it("reads the notes with the four alerts on top and both languages collapsed as it reads them with en-us open", () => {
    expect(parseNotes(collapsedNotesText(), PRERELEASE_FILE)).toEqual(
      parseNotes(notesText(), PRERELEASE_FILE),
    );
  });

  it("ignores an image line under a pt-br item", () => {
    const text = notesText().replace(
      `- ✨ ${NOTICE.pt}`,
      `- ✨ ${NOTICE.pt}\n  ![pt](${GIF_C})`,
    );

    expect(parseNotes(text, PRERELEASE_FILE)["pt-br"].features[1].gif).toBe(
      null,
    );
  });

  it("throws when the notes have no pt-br block", () => {
    expect(() =>
      parseNotes("### 📋 Summary\n- One.\n", PRERELEASE_FILE),
    ).toThrow(
      `${PRERELEASE_FILE} has no <details><summary>🇧🇷 Português</summary> block`,
    );
  });

  it.each([
    ["en-us", "### 📋 Summary", "### Other"],
    ["pt-br", "### 📋 Resumo", "### Outro"],
  ])("throws when the %s part has no summary", (language, heading, other) => {
    expect(() =>
      parseNotes(notesText().replace(heading, other), PRERELEASE_FILE),
    ).toThrow(`${PRERELEASE_FILE} has no ${heading} in the ${language} part`);
  });

  it("throws when the two languages have a different number of ✨ items", () => {
    expect(() =>
      parseNotes(
        notesText({ ptFeatures: [QUESTIONS, NOTICE] }),
        PRERELEASE_FILE,
      ),
    ).toThrow(
      `${PRERELEASE_FILE} has 3 ✨ items in en-us and 2 in pt-br, which pair by order`,
    );
  });
});

describe("release-announce › posts of a pre-release", () => {
  it("posts the opening and one GIF per ✨ item that has one, only on the pre-release channels", () => {
    expect(
      buildAnnouncements({
        root: tempRoot(),
        version: PRERELEASE,
        repository: REPO,
      }),
    ).toEqual(PRERELEASE_ANNOUNCEMENTS);
  });

  it("posts the same from notes with the four alerts on top, both languages collapsed and the GIF under the pt-br items too", () => {
    expect(
      buildAnnouncements({
        root: tempRoot({ [PRERELEASE_FILE]: collapsedNotesText() }),
        version: PRERELEASE,
        repository: REPO,
      }),
    ).toEqual(PRERELEASE_ANNOUNCEMENTS);
  });

  it.each([
    ["0.3.0-beta.2", "beta", "docs/releases/0.3.0/beta.2.md"],
    ["0.3.0-rc.1", "next", "docs/releases/0.3.0/rc.1.md"],
  ])("installs %s from the %s tag of npm", (version, tag, file) => {
    const [announcement] = buildAnnouncements({
      root: tempRoot({ [file]: notesText() }),
      version,
      repository: REPO,
    });

    expect(announcement.posts[0].text).toContain(
      `<code>npx @pedromondek/better-claude-code-telegram@${tag}</code>`,
    );
    expect(announcement.posts[0].text).toContain(
      `<b>better-claude-code-telegram ${version}</b>`,
    );
  });

  it("throws when the version has no notes in the checked-out commit", () => {
    expect(() =>
      buildAnnouncements({
        root: tempRoot({}),
        version: PRERELEASE,
        repository: REPO,
      }),
    ).toThrow(
      `there are no notes of v${PRERELEASE} in ${PRERELEASE_FILE}, which the release records`,
    );
  });
});

describe("release-announce › posts of a stable version", () => {
  it("posts stable.md in full on the stable channels", () => {
    const [english, portuguese] = buildAnnouncements({
      root: tempRoot(stableFiles()),
      version: STABLE,
      repository: REPO,
    });

    expect(english).toEqual({
      chat: STABLE_EN,
      language: "en-us",
      posts: [
        {
          method: "sendMessage",
          text: opening({
            marker: "🚀",
            title: `better-claude-code-telegram ${STABLE}`,
            bullets: EN_SUMMARY,
            version: STABLE,
            language: "en-us",
            tag: null,
            includes: STABLE_INCLUDES,
          }),
        },
        ...animations(EN_CAPTIONS, [GIF_A, GIF_B, GIF_C]),
      ],
    });
    expect(portuguese).toEqual({
      chat: STABLE_PT,
      language: "pt-br",
      posts: [
        {
          method: "sendMessage",
          text: opening({
            marker: "🚀",
            title: `better-claude-code-telegram ${STABLE}`,
            bullets: PT_SUMMARY,
            version: STABLE,
            language: "pt-br",
            tag: null,
            includes: STABLE_INCLUDES,
          }),
        },
        ...animations(PT_CAPTIONS, [GIF_A, GIF_B, GIF_C]),
      ],
    });
  });

  it("tells the pre-release channels the version is stable, with only the ✨ items no pre-release of the folder had, by demo and by text when neither has one", () => {
    const [, , english, portuguese] = buildAnnouncements({
      root: tempRoot(stableFiles()),
      version: STABLE,
      repository: REPO,
    });

    expect(english).toEqual({
      chat: PRE_EN,
      language: "en-us",
      posts: [
        {
          method: "sendMessage",
          text: opening({
            marker: "✅",
            title: STABLE,
            bullets: ["• Voice messages are <b>transcribed</b>."],
            version: STABLE,
            language: "en-us",
            tag: null,
          }).replace(`<b>${STABLE}</b>`, `<b>${STABLE}</b> is stable`),
        },
        ...animations(EN_CAPTIONS, [GIF_C]),
      ],
    });
    expect(portuguese).toEqual({
      chat: PRE_PT,
      language: "pt-br",
      posts: [
        {
          method: "sendMessage",
          text: opening({
            marker: "✅",
            title: STABLE,
            bullets: ["• Mensagens de voz são <b>transcritas</b>."],
            version: STABLE,
            language: "pt-br",
            tag: null,
          }).replace(`<b>${STABLE}</b>`, `<b>${STABLE}</b> está estável`),
        },
        ...animations(PT_CAPTIONS, [GIF_C]),
      ],
    });
  });

  it("lists a new ✨ item without a GIF in the opening, with no post of its own", () => {
    const [, , english] = buildAnnouncements({
      root: tempRoot(
        stableFiles({
          [STABLE_FILE]: notesText({
            features: [
              ...STABLE_FEATURES,
              {
                en: "Replies are **faster**.",
                pt: "Respostas mais **rápidas**.",
                gif: null,
              },
            ],
          }),
        }),
      ),
      version: STABLE,
      repository: REPO,
    });

    expect(english.posts).toEqual([
      {
        method: "sendMessage",
        text: expect.stringContaining(
          "\n\n• Voice messages are <b>transcribed</b>.\n• Replies are <b>faster</b>.\n\n",
        ),
      },
      ...animations(EN_CAPTIONS, [GIF_C]),
    ]);
  });

  it("posts only the opening with the link when every ✨ item came in a pre-release", () => {
    const [, , english, portuguese] = buildAnnouncements({
      root: tempRoot(
        stableFiles({
          "docs/releases/0.3.0/rc.1.md": notesText({ features: [VOICE] }),
        }),
      ),
      version: STABLE,
      repository: REPO,
    });

    expect(english.posts).toEqual([
      {
        method: "sendMessage",
        text: [
          `✅ <b>${STABLE}</b> is stable`,
          "",
          `<a href="https://github.com/${REPO}/releases/tag/v${STABLE}">📝 Release notes</a>`,
          "Install: <code>npx @pedromondek/better-claude-code-telegram</code>",
        ].join("\n"),
      },
    ]);
    expect(portuguese.posts).toEqual([
      {
        method: "sendMessage",
        text: [
          `✅ <b>${STABLE}</b> está estável`,
          "",
          `<a href="https://github.com/${REPO}/releases/tag/v${STABLE}">📝 Notas da versão</a>`,
          "Instalar: <code>npx @pedromondek/better-claude-code-telegram</code>",
        ].join("\n"),
      },
    ]);
  });

  it("treats every ✨ item as new when the folder has no pre-release", () => {
    const [, , english] = buildAnnouncements({
      root: tempRoot({
        [STABLE_FILE]: notesText({ features: STABLE_FEATURES }),
      }),
      version: STABLE,
      repository: REPO,
    });

    expect(english.posts.map((post) => post.animation ?? null)).toEqual([
      null,
      GIF_A,
      GIF_B,
      GIF_C,
    ]);
  });
});

describe("release-announce › the ✨ of the items", () => {
  it("drops the leading ✨ of the item in the caption of its GIF post", () => {
    const [announcement] = buildAnnouncements({
      root: tempRoot(),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(announcement.posts[1].caption).toBe(
      "Questions arrive with <b>buttons</b> &amp; <code>options</code>.",
    );
  });

  it("lists the new items of a stable version without the leading ✨", () => {
    const [, , english] = buildAnnouncements({
      root: tempRoot(stableFiles()),
      version: STABLE,
      repository: REPO,
    });

    expect(english.posts[0].text).toContain(
      "\n\n• Voice messages are <b>transcribed</b>.\n\n",
    );
    expect(english.posts[0].text).not.toContain("• ✨");
  });

  it("keeps a ✨ in the middle of the item text", () => {
    const middle = "Stars ✨ stay in the middle.";
    const [announcement] = buildAnnouncements({
      root: tempRoot({
        [PRERELEASE_FILE]: notesText({
          features: [{ en: middle, pt: middle, gif: GIF_A }],
        }),
      }),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(announcement.posts[1].caption).toBe(middle);
  });
});

describe("release-announce › the media of the items", () => {
  const withVideo = (video, gif = GIF_A) =>
    notesText({ features: [{ ...QUESTIONS, gif, video }, NOTICE] });

  it("sends the MP4 of the telegram comment instead of the GIF, as video/mp4", () => {
    const [announcement, portuguese] = buildAnnouncements({
      root: tempRoot({ [PRERELEASE_FILE]: withVideo(VIDEO_A) }),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(announcement.posts[1]).toEqual({
      method: "sendAnimation",
      caption: EN_CAPTIONS[GIF_A],
      animation: VIDEO_A,
      contentType: "video/mp4",
      fileName: "animation.mp4",
    });
    expect(portuguese.posts[1].animation).toBe(VIDEO_A);
  });

  it("falls back to the GIF, as image/gif, when the item has no telegram comment", () => {
    const [announcement] = buildAnnouncements({
      root: tempRoot({ [PRERELEASE_FILE]: withVideo(null) }),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(announcement.posts[1]).toEqual(animations(EN_CAPTIONS, [GIF_A])[0]);
  });

  it("posts the MP4 of an item that has no GIF", () => {
    const [announcement] = buildAnnouncements({
      root: tempRoot({ [PRERELEASE_FILE]: withVideo(VIDEO_A, null) }),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(announcement.posts.map((post) => post.animation ?? null)).toEqual([
      null,
      VIDEO_A,
    ]);
  });

  it.each([
    ["https://example.test/demo.mp4", "video/mp4", "animation.mp4"],
    ["https://example.test/demo.MP4?raw=1", "video/mp4", "animation.mp4"],
    ["https://example.test/demo.gif", "image/gif", "animation.gif"],
  ])(
    "takes the content type and the file name of %s from its extension",
    (url, contentType, fileName) => {
      const [announcement] = buildAnnouncements({
        root: tempRoot({ [PRERELEASE_FILE]: withVideo(url) }),
        version: PRERELEASE,
        repository: REPO,
      });

      expect(announcement.posts[1]).toMatchObject({
        animation: url,
        contentType,
        fileName,
      });
    },
  );

  it("takes the type of the line for an attachment URL without an extension", () => {
    const [gifOnly] = buildAnnouncements({
      root: tempRoot({ [PRERELEASE_FILE]: withVideo(null, GIF_A) }),
      version: PRERELEASE,
      repository: REPO,
    });
    const [videoOnly] = buildAnnouncements({
      root: tempRoot({ [PRERELEASE_FILE]: withVideo(VIDEO_A, null) }),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(gifOnly.posts[1].contentType).toBe("image/gif");
    expect(videoOnly.posts[1].contentType).toBe("video/mp4");
  });

  it.each([
    ["https://example.test/demo.webm", ".webm"],
    ["https://example.test/demo.png", ".png"],
  ])("throws naming the URL of an unknown extension (%s)", (url, extension) => {
    expect(() =>
      buildAnnouncements({
        root: tempRoot({ [PRERELEASE_FILE]: withVideo(url) }),
        version: PRERELEASE,
        repository: REPO,
      }),
    ).toThrow(
      `${url} has the extension ${extension}, but the announcement sends only .gif and .mp4`,
    );
  });

  it("matches a stable item to a pre-release one by its MP4 when the GIF and the text differ", () => {
    const [, , english] = buildAnnouncements({
      root: tempRoot({
        [STABLE_FILE]: notesText({
          features: [{ ...VOICE, video: VIDEO_C }],
        }),
        [PRERELEASE_FILE]: notesText({
          features: [
            {
              en: "Voice is now text.",
              pt: "Voz vira texto.",
              gif: GIF_B,
              video: VIDEO_C,
            },
          ],
        }),
      }),
      version: STABLE,
      repository: REPO,
    });

    expect(english.posts).toHaveLength(1);
  });

  it("prints the MP4 that is sent, not the GIF", async () => {
    const { out } = await announceWith({
      args: ["--print"],
      root: tempRoot({ [PRERELEASE_FILE]: withVideo(VIDEO_A) }),
    });

    expect(out[1].split("\n")[0]).toBe(
      `${PRE_EN} · sendAnimation · ${VIDEO_A} · reply to the opening`,
    );
  });

  it("uploads the MP4 as video/mp4 with a .mp4 file name", async () => {
    const { code, calls } = await announceWith({
      root: tempRoot({ [PRERELEASE_FILE]: withVideo(VIDEO_A) }),
    });
    const posts = await sentPosts(calls);

    expect(code).toBe(0);
    expect(calls[0].url).toBe(VIDEO_A);
    expect(posts[1].animation).toEqual({
      type: "video/mp4",
      name: "animation.mp4",
      bytes: `bytes of ${VIDEO_A}`,
    });
  });
});

describe("release-announce › captions", () => {
  const withParagraphs = () =>
    notesText()
      .replace(
        `- ✨ ${QUESTIONS.en}\n`,
        `- ✨ ${QUESTIONS.en}\n\n  You **gain** time\n  on every answer.\n`,
      )
      .replace(
        `  ![demo](${GIF_A})`,
        `  ![demo](${GIF_A})\n  <!-- telegram: ${VIDEO_A} -->\n  <!-- a note -->\n\n  Third paragraph.`,
      );

  it("joins the item and its extra paragraphs with a blank line in the caption", () => {
    const [english, portuguese] = buildAnnouncements({
      root: tempRoot({ [PRERELEASE_FILE]: withParagraphs() }),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(english.posts[1].caption).toBe(
      `${EN_CAPTIONS[GIF_A]}\n\nYou <b>gain</b> time on every answer.\n\nThird paragraph.`,
    );
    expect(portuguese.posts[1].caption).toBe(PT_CAPTIONS[GIF_A]);
  });

  it("keeps the image and the comment lines out of the paragraphs", () => {
    expect(
      parseNotes(withParagraphs(), PRERELEASE_FILE)["en-us"].features[0],
    ).toEqual({
      text: `✨ ${QUESTIONS.en}`,
      paragraphs: ["You **gain** time on every answer.", "Third paragraph."],
      gif: GIF_A,
      video: VIDEO_A,
    });
  });

  it("takes the extra paragraphs of the pt-br item into its own caption", () => {
    const [english, portuguese] = buildAnnouncements({
      root: tempRoot({
        [PRERELEASE_FILE]: notesText().replace(
          `- ✨ ${QUESTIONS.pt}`,
          `- ✨ ${QUESTIONS.pt}\n\n  Você **ganha** tempo.`,
        ),
      }),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(portuguese.posts[1].caption).toBe(
      `${PT_CAPTIONS[GIF_A]}\n\nVocê <b>ganha</b> tempo.`,
    );
    expect(english.posts[1].caption).toBe(EN_CAPTIONS[GIF_A]);
  });

  const withLongParagraph = (length) =>
    notesText({
      features: [{ en: "Short.", pt: "Curto.", gif: GIF_A }],
    }).replace(
      `  ![demo](${GIF_A})`,
      `  ![demo](${GIF_A})\n\n  ${"a".repeat(length)}`,
    );

  it("accepts a joined caption of exactly 1024 characters", () => {
    const [english] = buildAnnouncements({
      root: tempRoot({ [PRERELEASE_FILE]: withLongParagraph(1016) }),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(english.posts[1].caption).toHaveLength(1024);
  });

  it("counts the 1024 limit on the caption joined with its paragraphs", () => {
    expect(() =>
      buildAnnouncements({
        root: tempRoot({ [PRERELEASE_FILE]: withLongParagraph(1017) }),
        version: PRERELEASE,
        repository: REPO,
      }),
    ).toThrow(
      `the ✨ item "✨ Short." of ${PRE_EN} makes a caption of 1025 characters, over the 1024 Telegram takes`,
    );
  });
});

describe("release-announce › the MP4 of each language", () => {
  const announcementsOf = (item) =>
    buildAnnouncements({
      root: tempRoot({
        [PRERELEASE_FILE]: notesText({ features: [item, NOTICE] }),
      }),
      version: PRERELEASE,
      repository: REPO,
    });

  it("sends the pt-br MP4 of the pt-br item on the pt-br channel", () => {
    const [english, portuguese] = announcementsOf({
      ...QUESTIONS,
      video: VIDEO_A,
      ptVideo: VIDEO_PT,
    });

    expect(english.posts[1].animation).toBe(VIDEO_A);
    expect(portuguese.posts[1]).toMatchObject({
      animation: VIDEO_PT,
      contentType: "video/mp4",
      fileName: "animation.mp4",
    });
  });

  it("sends the pt-br MP4 when only the pt-br item has one, and the GIF on en-us", () => {
    const [english, portuguese] = announcementsOf({
      ...QUESTIONS,
      ptVideo: VIDEO_PT,
    });

    expect(english.posts[1].animation).toBe(GIF_A);
    expect(portuguese.posts[1].animation).toBe(VIDEO_PT);
  });

  it("falls back to the en-us MP4 when the pt-br item has none", () => {
    const [, portuguese] = announcementsOf({ ...QUESTIONS, video: VIDEO_A });

    expect(portuguese.posts[1].animation).toBe(VIDEO_A);
  });

  it("falls back to the GIF when neither item has an MP4", () => {
    const [, portuguese] = announcementsOf(QUESTIONS);

    expect(portuguese.posts[1]).toMatchObject({
      animation: GIF_A,
      contentType: "image/gif",
    });
  });

  it("matches a stable item to the pre-releases by its en-us item, never by the pt-br MP4", () => {
    const [, , english] = buildAnnouncements({
      root: tempRoot({
        [STABLE_FILE]: notesText({
          features: [{ ...VOICE, ptVideo: VIDEO_C }],
        }),
        [PRERELEASE_FILE]: notesText({
          features: [
            { en: "Other.", pt: "Outro.", gif: GIF_B, video: VIDEO_C },
          ],
        }),
      }),
      version: STABLE,
      repository: REPO,
    });

    expect(english.posts.map((post) => post.animation ?? null)).toEqual([
      null,
      GIF_C,
    ]);
  });
});

const BETA = "0.3.0-beta.1";
const ALPHA_1 = "0.3.0-alpha.1";
const ALPHA_2 = "0.3.0-alpha.2";
const TELEGRAM_EN = "https://t.me/bcct_tips_prereleases/40";
const TELEGRAM_PT = "https://t.me/bcct_tips_prelancamentos/38";
const TELEGRAM_LINE = `📣 Telegram: [${PRE_EN}](${TELEGRAM_EN}) · [${PRE_PT}](${TELEGRAM_PT})`;

const folderFile = (name) => `docs/releases/0.3.0/${name}.md`;
const item = (en, gif, video = null) => ({ en, pt: `${en} (pt)`, gif, video });
const featuresFile = (...features) => notesText({ features });
const buildAt = (files, version, extra = {}) =>
  buildAnnouncements({
    root: tempRoot(files),
    version,
    repository: REPO,
    ...extra,
  });
const animationsOf = ({ posts }) =>
  posts
    .filter(({ method }) => method === "sendAnimation")
    .map(({ animation }) => animation);

describe("release-announce › freshness of the ✨ items", () => {
  it("posts again an item that gained a demo", () => {
    const [, , english] = buildAt(
      {
        [STABLE_FILE]: featuresFile(item("Replies are faster.", GIF_A)),
        [PRERELEASE_FILE]: featuresFile(item("Replies are faster.", null)),
      },
      STABLE,
    );

    expect(animationsOf(english)).toEqual([GIF_A]);
  });

  it("posts again an item that got a new demo with the same text", () => {
    const [, , english] = buildAt(
      {
        [STABLE_FILE]: featuresFile(item("Replies are faster.", GIF_B)),
        [PRERELEASE_FILE]: featuresFile(item("Replies are faster.", GIF_A)),
      },
      STABLE,
    );

    expect(animationsOf(english)).toEqual([GIF_B]);
  });

  it("does not post a reworded item that keeps its demo", () => {
    const [, , english, portuguese] = buildAt(
      {
        [STABLE_FILE]: featuresFile(item("Replies come faster now.", GIF_A)),
        [PRERELEASE_FILE]: featuresFile(item("Replies are faster.", GIF_A)),
      },
      STABLE,
    );

    expect(animationsOf(english)).toEqual([]);
    expect(animationsOf(portuguese)).toEqual([]);
  });

  it("does not post an item without a demo whose text differs only in case and spaces", () => {
    const [, , english] = buildAt(
      {
        [STABLE_FILE]: featuresFile(item("  replies   ARE faster. ", null)),
        [PRERELEASE_FILE]: featuresFile(item("Replies are faster.", null)),
      },
      STABLE,
    );

    expect(english.posts).toHaveLength(1);
    expect(english.posts[0].text).not.toContain("faster");
  });

  it("lists an item without a demo whose text is new", () => {
    const [, , english] = buildAt(
      {
        [STABLE_FILE]: featuresFile(item("Replies are much faster.", null)),
        [PRERELEASE_FILE]: featuresFile(item("Replies are faster.", null)),
      },
      STABLE,
    );

    expect(english.posts[0].text).toContain("• Replies are much faster.");
  });

  it("does not match an item without a demo to one that has a demo", () => {
    const [, , english] = buildAt(
      {
        [STABLE_FILE]: featuresFile(item("Replies are faster.", null)),
        [PRERELEASE_FILE]: featuresFile(item("Replies are faster.", GIF_A)),
      },
      STABLE,
    );

    expect(english.posts[0].text).toContain("• Replies are faster.");
  });

  it("takes the MP4 as the demo of an item that has both, so the GIF alone is not the same demo", () => {
    const [, , english] = buildAt(
      {
        [STABLE_FILE]: featuresFile(item("Replies are faster.", GIF_A)),
        [PRERELEASE_FILE]: featuresFile(
          item("Replies are faster.", GIF_A, VIDEO_A),
        ),
      },
      STABLE,
    );

    expect(animationsOf(english)).toEqual([GIF_A]);
  });

  it("posts only the demos that no earlier pre-release posted, keeping the whole summary in the opening", () => {
    const [english, portuguese] = buildAt(
      {
        [folderFile("alpha.1")]: featuresFile(item("Questions.", GIF_A)),
        [folderFile("beta.1")]: featuresFile(
          item("Questions.", GIF_A),
          item("Updates.", GIF_B),
        ),
      },
      BETA,
    );

    expect(animationsOf(english)).toEqual([GIF_B]);
    expect(animationsOf(portuguese)).toEqual([GIF_B]);
    expect(english.posts[0].text).toContain("• <b>Buttons</b> answer");
    expect(english.posts[0].text).toContain("• The setup is faster.");
    expect(portuguese.posts[0].text).toContain("• <b>Botões</b> respondem");
  });

  it("posts only the opening when every demo of a pre-release was posted before", () => {
    const [english] = buildAt(
      {
        [folderFile("alpha.1")]: featuresFile(item("Questions.", GIF_A)),
        [folderFile("alpha.2")]: featuresFile(item("Questions.", GIF_A)),
      },
      ALPHA_2,
    );

    expect(english.posts).toHaveLength(1);
  });

  it("does not count a later pre-release of the folder as seen", () => {
    const [english] = buildAt(
      {
        [folderFile("beta.1")]: featuresFile(item("Questions.", GIF_A)),
        [folderFile("beta.2")]: featuresFile(item("Questions.", GIF_A)),
      },
      BETA,
    );

    expect(animationsOf(english)).toEqual([GIF_A]);
  });

  it("counts every earlier pre-release of the folder as seen, from any stage", () => {
    const [english] = buildAt(
      {
        [folderFile("alpha.1")]: featuresFile(item("One.", GIF_A)),
        [folderFile("beta.1")]: featuresFile(item("Two.", GIF_B)),
        [folderFile("rc.1")]: featuresFile(
          item("One.", GIF_A),
          item("Two.", GIF_B),
          item("Three.", GIF_C),
        ),
      },
      "0.3.0-rc.1",
    );

    expect(animationsOf(english)).toEqual([GIF_C]);
  });

  it("matches only the en-us item of the earlier pre-releases", () => {
    const [english, portuguese] = buildAt(
      {
        [folderFile("alpha.1")]: featuresFile({
          en: "Other.",
          pt: "Outro.",
          gif: GIF_B,
          ptVideo: VIDEO_PT,
        }),
        [folderFile("alpha.2")]: featuresFile({
          en: "Voice.",
          pt: "Voz.",
          gif: GIF_C,
          ptVideo: VIDEO_PT,
        }),
      },
      ALPHA_2,
    );

    expect(animationsOf(english)).toEqual([GIF_C]);
    expect(animationsOf(portuguese)).toEqual([VIDEO_PT]);
  });
});

describe("release-announce › the Includes block", () => {
  const stageFiles = (extra = {}) => ({
    [folderFile("alpha.1")]: featuresFile(QUESTIONS),
    [folderFile("alpha.2")]: featuresFile(NOTICE),
    [folderFile("beta.1")]: notesText(),
    ...extra,
  });
  const includesOf = (...versions) => versions.map((version) => ({ version }));

  it("lists the alphas in the opening of the first beta, in both languages", () => {
    const [english, portuguese] = buildAt(stageFiles(), BETA);

    expect(english.posts[0].text).toBe(
      opening({
        marker: "🧪",
        title: `better-claude-code-telegram ${BETA}`,
        bullets: EN_SUMMARY,
        version: BETA,
        language: "en-us",
        tag: "beta",
        includes: includesOf(ALPHA_1, ALPHA_2),
      }),
    );
    expect(portuguese.posts[0].text).toBe(
      opening({
        marker: "🧪",
        title: `better-claude-code-telegram ${BETA}`,
        bullets: PT_SUMMARY,
        version: BETA,
        language: "pt-br",
        tag: "beta",
        includes: includesOf(ALPHA_1, ALPHA_2),
      }),
    );
    expect(animationsOf(english)).toEqual([GIF_B]);
  });

  it("shows the Includes block after the summary and before the Release notes link", () => {
    const [english] = buildAt(stageFiles(), BETA);

    expect(english.posts[0].text.split("\n")).toEqual([
      `🧪 <b>better-claude-code-telegram ${BETA}</b>`,
      "",
      ...EN_SUMMARY,
      "",
      "Includes:",
      `• v${ALPHA_1}`,
      `   <a href="${releaseLink(ALPHA_1)}">🔗 Release</a>`,
      `• v${ALPHA_2}`,
      `   <a href="${releaseLink(ALPHA_2)}">🔗 Release</a>`,
      "",
      `<a href="${releaseLink(BETA)}">📝 Release notes</a>`,
      "Install: <code>npx @pedromondek/better-claude-code-telegram@beta</code>",
    ]);
  });

  it("does not double the blank line when the notes have no summary bullets", () => {
    const [english] = buildAt(
      stageFiles({
        [folderFile("beta.1")]: notesText({ summaryEn: [], summaryPt: [] }),
      }),
      BETA,
    );

    expect(english.posts[0].text.split("\n").slice(0, 4)).toEqual([
      `🧪 <b>better-claude-code-telegram ${BETA}</b>`,
      "",
      "Includes:",
      `• v${ALPHA_1}`,
    ]);
    expect(english.posts[0].text).not.toContain("\n\n\n");
  });

  it("lists no Includes for the first alpha and for the later versions of a stage", () => {
    const files = stageFiles({
      [folderFile("beta.2")]: notesText(),
      [folderFile("alpha.3")]: notesText(),
    });

    for (const version of [ALPHA_1, "0.3.0-alpha.3", "0.3.0-beta.2"]) {
      const [english] = buildAt(files, version);

      expect(english.posts[0].text).not.toContain("Includes:");
    }
  });

  it("lists only the betas in the opening of the first rc", () => {
    const [english] = buildAt(
      stageFiles({
        [folderFile("beta.2")]: notesText(),
        [folderFile("rc.1")]: notesText(),
      }),
      "0.3.0-rc.1",
    );

    expect(english.posts[0].text).toContain(
      [
        "Includes:",
        `• v${BETA}`,
        `   <a href="${releaseLink(BETA)}">🔗 Release</a>`,
        "• v0.3.0-beta.2",
      ].join("\n"),
    );
    expect(english.posts[0].text).not.toContain(`v${ALPHA_1}`);
  });

  it("lists every pre-release in the opening of a stable version on the stable channels, in pt-br too", () => {
    const [english, portuguese] = buildAt(
      stageFiles({
        [STABLE_FILE]: notesText({ features: STABLE_FEATURES }),
      }),
      STABLE,
    );

    expect(english.posts[0].text).toContain(
      `Includes:\n• v${ALPHA_1}\n   <a href="${releaseLink(ALPHA_1)}">🔗 Release</a>\n• v${ALPHA_2}\n   <a href="${releaseLink(ALPHA_2)}">🔗 Release</a>\n• v${BETA}`,
    );
    expect(portuguese.posts[0].text).toContain("Inclui:\n• v");
  });

  it("shows no Includes in the stable news of the pre-release channels", () => {
    const channels = buildAt(
      stageFiles({
        [STABLE_FILE]: notesText({ features: STABLE_FEATURES }),
      }),
      STABLE,
    );

    expect(channels[2].posts[0].text).not.toContain("Includes:");
    expect(channels[3].posts[0].text).not.toContain("Inclui:");
    expect(channels[2].posts[0].text).toContain("📝 Release notes");
    expect(channels[3].posts[0].text).toContain("📝 Notas da versão");
  });
});

describe("release-announce › the Telegram links of the included versions", () => {
  const files = {
    [folderFile("alpha.1")]: featuresFile(QUESTIONS),
    [folderFile("alpha.2")]: featuresFile(NOTICE),
    [folderFile("beta.1")]: notesText(),
    [STABLE_FILE]: notesText({ features: STABLE_FEATURES }),
  };
  const telegramOf = (text, version) => {
    const lines = text.split("\n");
    const at = lines.indexOf(`• v${version}`);

    return lines[at + 1];
  };

  it("links the record of the channel of each included version, and only the Release when it has none", () => {
    const [english, portuguese] = buildAt(files, BETA, {
      records: {
        [ALPHA_1]: { [PRE_EN]: TELEGRAM_EN, [PRE_PT]: TELEGRAM_PT },
      },
    });

    expect(telegramOf(english.posts[0].text, ALPHA_1)).toBe(
      `   <a href="${TELEGRAM_EN}">📣 Telegram</a> · <a href="${releaseLink(ALPHA_1)}">🔗 Release</a>`,
    );
    expect(telegramOf(portuguese.posts[0].text, ALPHA_1)).toBe(
      `   <a href="${TELEGRAM_PT}">📣 Telegram</a> · <a href="${releaseLink(ALPHA_1)}">🔗 Release</a>`,
    );
    expect(telegramOf(english.posts[0].text, ALPHA_2)).toBe(
      `   <a href="${releaseLink(ALPHA_2)}">🔗 Release</a>`,
    );
  });

  it("falls back to the record of the pre-release channel of the same language on the stable channels", () => {
    const [english, portuguese] = buildAt(files, STABLE, {
      records: {
        [ALPHA_1]: { [PRE_EN]: TELEGRAM_EN, [PRE_PT]: TELEGRAM_PT },
      },
    });

    expect(telegramOf(english.posts[0].text, ALPHA_1)).toBe(
      `   <a href="${TELEGRAM_EN}">📣 Telegram</a> · <a href="${releaseLink(ALPHA_1)}">🔗 Release</a>`,
    );
    expect(telegramOf(portuguese.posts[0].text, ALPHA_1)).toBe(
      `   <a href="${TELEGRAM_PT}">📣 Telegram</a> · <a href="${releaseLink(ALPHA_1)}">🔗 Release</a>`,
    );
  });

  it("prefers the record of the channel itself over the pre-release channel of its language", () => {
    const [english] = buildAt(files, STABLE, {
      records: {
        [ALPHA_1]: {
          [STABLE_EN]: "https://t.me/bcct_tips/7",
          [PRE_EN]: TELEGRAM_EN,
        },
      },
    });

    expect(telegramOf(english.posts[0].text, ALPHA_1)).toContain(
      'href="https://t.me/bcct_tips/7"',
    );
  });

  it("links only the Release when the records have neither the channel nor the pre-release channel of its language", () => {
    const [english] = buildAt(files, STABLE, {
      records: {
        [ALPHA_1]: { [PRE_PT]: TELEGRAM_PT },
        [ALPHA_2]: {},
      },
    });

    expect(telegramOf(english.posts[0].text, ALPHA_1)).toBe(
      `   <a href="${releaseLink(ALPHA_1)}">🔗 Release</a>`,
    );
    expect(telegramOf(english.posts[0].text, ALPHA_2)).toBe(
      `   <a href="${releaseLink(ALPHA_2)}">🔗 Release</a>`,
    );
    expect(telegramOf(english.posts[0].text, BETA)).toBe(
      `   <a href="${releaseLink(BETA)}">🔗 Release</a>`,
    );
  });

  it("escapes the record URL inside the href", () => {
    const [english] = buildAt(files, BETA, {
      records: { [ALPHA_1]: { [PRE_EN]: 'https://t.me/x?a=1&b="2' } },
    });

    expect(english.posts[0].text).toContain(
      '<a href="https://t.me/x?a=1&amp;b=&quot;2">📣 Telegram</a>',
    );
  });

  it("keeps --print offline, reading no Release and linking only the Release of each included version", async () => {
    const { code, out, github } = await announceWith({
      args: ["--print"],
      root: tempRoot(files),
      env: { VERSION: BETA },
    });

    expect(code).toBe(0);
    expect(github.reads).toEqual([]);
    expect(out[0]).toContain(
      `• v${ALPHA_1}\n   <a href="${releaseLink(ALPHA_1)}">🔗 Release</a>`,
    );
    expect(out.join("\n")).not.toContain("📣");
  });

  it("reads the Release of each included version before posting and links what their lines hold", async () => {
    const { code, calls, github } = await announceWith({
      root: tempRoot(files),
      env: { VERSION: BETA },
      github: fakeGithub({
        bodies: { [`v${ALPHA_1}`]: `Notes.\n\n${TELEGRAM_LINE}` },
      }),
    });
    const posts = await sentPosts(calls);

    expect(code).toBe(0);
    expect(github.reads).toEqual([`v${ALPHA_1}`, `v${ALPHA_2}`]);
    expect(posts[0].text).toContain(
      `<a href="${TELEGRAM_EN}">📣 Telegram</a> · <a href="${releaseLink(ALPHA_1)}">🔗 Release</a>`,
    );
    expect(posts.find(({ chat }) => chat === PRE_PT).text).toContain(
      `<a href="${TELEGRAM_PT}">📣 Telegram</a>`,
    );
    expect(posts[0].text).not.toContain(
      `<a href="${TELEGRAM_EN}">📣 Telegram</a> · <a href="${releaseLink(ALPHA_2)}">`,
    );
  });

  it("reads the Releases on DRY_RUN=1 too", async () => {
    const { code, github } = await announceWith({
      root: tempRoot(files),
      env: {
        VERSION: BETA,
        DRY_RUN: "1",
        TELEGRAM_TEST_CHANNEL: TEST_CHANNEL,
      },
    });

    expect(code).toBe(0);
    expect(github.reads).toEqual([`v${ALPHA_1}`, `v${ALPHA_2}`]);
  });

  it("reads no Release for a version that includes none", async () => {
    const { github } = await announceWith();

    expect(github.reads).toEqual([]);
  });

  it("fails before any post when the Release of an included version cannot be read", async () => {
    const { code, err, calls } = await announceWith({
      root: tempRoot(files),
      env: { VERSION: BETA },
      github: fakeGithub({ failOn: "read" }),
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(err).toEqual(["✗ gh is down"]);
  });

  it("fails with the notes message when the folder of the version has no notes", async () => {
    const { code, err, calls } = await announceWith({
      root: tempRoot({}),
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(err).toEqual([
      `✗ there are no notes of v${PRERELEASE} in ${PRERELEASE_FILE}, which the release records`,
    ]);
  });
});

describe("release-announce › the Telegram line of a Release", () => {
  it("reads the channel and the link of each entry of the line", () => {
    expect(parseTelegramLine(`Notes.\n\n${TELEGRAM_LINE}`)).toEqual({
      [PRE_EN]: TELEGRAM_EN,
      [PRE_PT]: TELEGRAM_PT,
    });
  });

  it("reads the line from a body with CRLF line ends", () => {
    expect(
      parseTelegramLine(`Notes.\r\n\r\n${TELEGRAM_LINE}\r\nMore.\r\n`),
    ).toEqual({ [PRE_EN]: TELEGRAM_EN, [PRE_PT]: TELEGRAM_PT });
  });

  it("reads the line when it is not the last of the body", () => {
    expect(parseTelegramLine(`${TELEGRAM_LINE}\n\nMore.`)).toEqual({
      [PRE_EN]: TELEGRAM_EN,
      [PRE_PT]: TELEGRAM_PT,
    });
  });

  it.each([
    ["an empty body", ""],
    ["a body without the line", "Notes.\n\n📣 Telegram is nice"],
    ["the prefix in the middle of a line", `See ${TELEGRAM_LINE}`],
    ["a line without links", "📣 Telegram: soon"],
    [
      "a link that is not a t.me one",
      `📣 Telegram: [${PRE_EN}](https://example.com/40)`,
    ],
  ])("gives an empty object for %s", (_case, body) => {
    expect(parseTelegramLine(body)).toEqual({});
  });

  it("writes the channels in the order of the stable ones and then the pre-release ones, only those present", () => {
    expect(
      telegramLine({
        [PRE_PT]: TELEGRAM_PT,
        [STABLE_EN]: "https://t.me/bcct_tips/7",
        [PRE_EN]: TELEGRAM_EN,
      }),
    ).toBe(
      `📣 Telegram: [${STABLE_EN}](https://t.me/bcct_tips/7) · [${PRE_EN}](${TELEGRAM_EN}) · [${PRE_PT}](${TELEGRAM_PT})`,
    );
    expect(telegramLine({ [PRE_EN]: TELEGRAM_EN })).toBe(
      `📣 Telegram: [${PRE_EN}](${TELEGRAM_EN})`,
    );
  });

  it("writes a line that it reads back the same", () => {
    const links = {
      [STABLE_PT]: "https://t.me/bcct_tips_br/3",
      [PRE_EN]: TELEGRAM_EN,
    };

    expect(parseTelegramLine(telegramLine(links))).toEqual(links);
  });

  it("writes nothing when no channel of the announcement is present", () => {
    expect(telegramLine({})).toBe("");
    expect(telegramLine({ "@other": "https://t.me/other/1" })).toBe("");
  });
});

describe("release-announce › recording the openings", () => {
  const V = `v${PRERELEASE}`;
  const DRY = { DRY_RUN: "1", TELEGRAM_TEST_CHANNEL: TEST_CHANNEL };
  const rejectCall = (failing) => (count) =>
    count === failing
      ? { status: 400, body: { ok: false, description: "Bad Request" } }
      : sentWithId(count);

  it("records the cumulative openings each time a channel opening is posted", async () => {
    const { code, recorded } = await announceWith();

    expect(code).toBe(0);
    expect(recorded).toEqual([
      { [PRE_EN]: 101 },
      { [PRE_EN]: 101, [PRE_PT]: 104 },
    ]);
  });

  it("records the opening given by ANNOUNCE_RESUME when the loop reaches its channel", async () => {
    const { recorded } = await announceWith({
      env: { ANNOUNCE_RESUME: `${V},${PRE_EN}=done,${PRE_PT}=104:2` },
    });

    expect(recorded).toEqual([{ [PRE_PT]: 104 }]);
  });

  it("records the openings of two resumed channels one after the other", async () => {
    const { recorded } = await announceWith({
      env: { ANNOUNCE_RESUME: `${V},${PRE_EN}=101:3,${PRE_PT}=104:3` },
    });

    expect(recorded).toEqual([
      { [PRE_EN]: 101 },
      { [PRE_EN]: 101, [PRE_PT]: 104 },
    ]);
  });

  it("records nothing when every channel is done", async () => {
    const { code, recorded } = await announceWith({
      env: { ANNOUNCE_RESUME: `${V},${PRE_EN}=done,${PRE_PT}=done` },
    });

    expect(code).toBe(0);
    expect(recorded).toEqual([]);
  });

  it("records nothing on DRY_RUN=1", async () => {
    const { code, recorded } = await announceWith({ env: DRY });

    expect(code).toBe(0);
    expect(recorded).toEqual([]);
  });

  it("records nothing on --print", async () => {
    const { recorded } = await announceWith({ args: ["--print"] });

    expect(recorded).toEqual([]);
  });

  it("keeps the opening of the first channel when a post of the next channel fails", async () => {
    const { code, recorded } = await announceWith({
      fetch: { telegram: rejectCall(4) },
    });

    expect(code).toBe(1);
    expect(recorded).toEqual([{ [PRE_EN]: 101 }]);
  });

  it("keeps both openings when a GIF of the second channel fails", async () => {
    const { code, recorded } = await announceWith({
      fetch: { telegram: rejectCall(5) },
    });

    expect(code).toBe(1);
    expect(recorded).toEqual([
      { [PRE_EN]: 101 },
      { [PRE_EN]: 101, [PRE_PT]: 104 },
    ]);
  });

  it("records nothing when the first opening fails", async () => {
    const { code, recorded } = await announceWith({
      fetch: { telegram: rejectCall(1) },
    });

    expect(code).toBe(1);
    expect(recorded).toEqual([]);
  });

  it("appends the openings as a line of GITHUB_OUTPUT, the last line being the cumulative one", async () => {
    const output = join(
      mkdtempSync(join(tmpdir(), "output-")),
      "github-output",
    );
    const { code } = await announceWith({
      env: { GITHUB_OUTPUT: output },
      record: null,
    });

    expect(code).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      `openings=${JSON.stringify({ [PRE_EN]: 101 })}\nopenings=${JSON.stringify({ [PRE_EN]: 101, [PRE_PT]: 104 })}\n`,
    );
  });

  it("posts without writing anywhere when GITHUB_OUTPUT is not set", async () => {
    const { code, out } = await announceWith({ record: null });

    expect(code).toBe(0);
    expect(out).toHaveLength(2);
  });

  it("writes nothing to GITHUB_OUTPUT on DRY_RUN=1", async () => {
    const output = join(
      mkdtempSync(join(tmpdir(), "output-")),
      "github-output",
    );
    const { code } = await announceWith({
      env: { ...DRY, GITHUB_OUTPUT: output },
      record: null,
    });

    expect(code).toBe(0);
    expect(() => readFileSync(output, "utf8")).toThrow(/ENOENT/u);
  });
});

describe("release-announce › link", () => {
  const LINK_ENV = {
    VERSION: PRERELEASE,
    TELEGRAM_ANNOUNCE_TOKEN: "",
  };
  const TAG = `v${PRERELEASE}`;
  const linkWith = (openings, body, env = {}) =>
    announceWith({
      args: ["link"],
      env: {
        ...LINK_ENV,
        OPENINGS:
          typeof openings === "string" ? openings : JSON.stringify(openings),
        ...env,
      },
      github: fakeGithub({ bodies: body === null ? {} : { [TAG]: body } }),
    });
  const lineOf = (links) => telegramLine(links);

  it("appends the Telegram line of the openings at the end of the Release body", async () => {
    const { code, out, calls, github } = await linkWith(
      { [PRE_EN]: 101, [PRE_PT]: 104 },
      "Notes.",
    );

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(github.edits).toEqual([
      {
        tag: TAG,
        body: `Notes.\n\n${lineOf({
          [PRE_EN]: "https://t.me/bcct_tips_prereleases/101",
          [PRE_PT]: "https://t.me/bcct_tips_prelancamentos/104",
        })}`,
      },
    ]);
    expect(out).toEqual([
      `✓ ${TAG}: recorded the Telegram links of ${PRE_EN}, ${PRE_PT}`,
    ]);
  });

  it("works without the announcement token", async () => {
    const { code, err } = await linkWith({ [STABLE_EN]: 7 }, "Notes.");

    expect(code).toBe(0);
    expect(err).toEqual([]);
  });

  it("merges the existing line with the new links", async () => {
    const { github } = await linkWith(
      { [PRE_PT]: 104 },
      `Notes.\n\n📣 Telegram: [${PRE_EN}](${TELEGRAM_EN})`,
    );

    expect(github.edits[0].body).toBe(
      `Notes.\n\n📣 Telegram: [${PRE_EN}](${TELEGRAM_EN}) · [${PRE_PT}](https://t.me/bcct_tips_prelancamentos/104)`,
    );
  });

  it("replaces only the chat it is given", async () => {
    const { github } = await linkWith(
      { [PRE_EN]: 55 },
      `Notes.\n\n${TELEGRAM_LINE}`,
    );

    expect(github.edits[0].body).toBe(
      `Notes.\n\n📣 Telegram: [${PRE_EN}](https://t.me/bcct_tips_prereleases/55) · [${PRE_PT}](${TELEGRAM_PT})`,
    );
  });

  it("removes the old line with the blank line before it and keeps the text after it", async () => {
    const { github } = await linkWith(
      { [PRE_EN]: 55 },
      `A\n\n${TELEGRAM_LINE}\n\nB`,
    );

    expect(github.edits[0].body).toBe(
      `A\n\nB\n\n📣 Telegram: [${PRE_EN}](https://t.me/bcct_tips_prereleases/55) · [${PRE_PT}](${TELEGRAM_PT})`,
    );
  });

  it("removes the old line of a body with CRLF line ends", async () => {
    const { github } = await linkWith(
      { [PRE_EN]: 55 },
      `Notes.\r\n\r\n${TELEGRAM_LINE}`,
    );

    expect(github.edits[0].body).toBe(
      `Notes.\n\n📣 Telegram: [${PRE_EN}](https://t.me/bcct_tips_prereleases/55) · [${PRE_PT}](${TELEGRAM_PT})`,
    );
  });

  it("writes the same body when run twice with the same openings", async () => {
    const first = await linkWith({ [PRE_EN]: 101 }, "Notes.");
    const second = await linkWith(
      { [PRE_EN]: 101 },
      first.github.edits[0].body,
    );

    expect(second.github.edits[0].body).toBe(first.github.edits[0].body);
  });

  it("appends to an empty body", async () => {
    const { github } = await linkWith({ [PRE_EN]: 101 }, "");

    expect(github.edits[0].body).toBe(
      `\n\n📣 Telegram: [${PRE_EN}](https://t.me/bcct_tips_prereleases/101)`,
    );
  });

  it.each([[""], ["{}"], [" \n"]])(
    "says there is nothing to record and edits nothing for OPENINGS %j",
    async (openings) => {
      const { code, out, err, github } = await linkWith(openings, "Notes.");

      expect(code).toBe(0);
      expect(out).toEqual(["nothing to record: no channel posted an opening"]);
      expect(err).toEqual([]);
      expect(github.reads).toEqual([]);
      expect(github.edits).toEqual([]);
    },
  );

  it("says there is nothing to record when OPENINGS is not set", async () => {
    const { code, out, github } = await announceWith({
      args: ["link"],
      env: LINK_ENV,
    });

    expect(code).toBe(0);
    expect(out).toEqual(["nothing to record: no channel posted an opening"]);
    expect(github.edits).toEqual([]);
  });

  it("refuses to run without VERSION", async () => {
    const { code, err, github } = await linkWith({ [PRE_EN]: 1 }, "Notes.", {
      VERSION: "",
    });

    expect(code).toBe(1);
    expect(err).toEqual(["✗ VERSION is required"]);
    expect(github.edits).toEqual([]);
  });

  it.each([
    ["not JSON", "not json"],
    ["a JSON array", "[1]"],
    ["JSON null", "null"],
    ["a JSON string", '"x"'],
    ["a JSON number", "5"],
  ])("refuses OPENINGS that is %s", async (_case, openings) => {
    const { code, err, github } = await linkWith(openings, "Notes.");

    expect(code).toBe(1);
    expect(err).toEqual([
      "✗ OPENINGS must be a JSON object of channel to opening id",
    ]);
    expect(github.edits).toEqual([]);
  });

  it.each([
    ["a string", "5"],
    ["zero", 0],
    ["a negative number", -3],
    ["a fraction", 1.5],
    ["null", null],
  ])("refuses an opening id that is %s", async (_case, id) => {
    const { code, err, github } = await linkWith({ [PRE_EN]: id }, "Notes.");

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ OPENINGS: the opening id of ${PRE_EN} must be a positive integer`,
    ]);
    expect(github.edits).toEqual([]);
  });

  it("refuses a chat that is not a channel of the announcement", async () => {
    const { code, err, github } = await linkWith(
      { [PRE_EN]: 1, "@other": 2 },
      "Notes.",
    );

    expect(code).toBe(1);
    expect(err).toEqual([
      "✗ OPENINGS: @other is not a channel of the announcement",
    ]);
    expect(github.edits).toEqual([]);
  });

  it("refuses when the version has no Release", async () => {
    const { code, err, github } = await linkWith({ [PRE_EN]: 1 }, null);

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ there is no Release ${TAG} to record the Telegram links in`,
    ]);
    expect(github.edits).toEqual([]);
  });

  it("fails when the Release cannot be read", async () => {
    const { code, err } = await announceWith({
      args: ["link"],
      env: { ...LINK_ENV, OPENINGS: JSON.stringify({ [PRE_EN]: 1 }) },
      github: fakeGithub({ failOn: "read" }),
    });

    expect(code).toBe(1);
    expect(err).toEqual(["✗ gh is down"]);
  });

  it("fails when the Release cannot be edited", async () => {
    const { code, err } = await announceWith({
      args: ["link"],
      env: { ...LINK_ENV, OPENINGS: JSON.stringify({ [PRE_EN]: 1 }) },
      github: fakeGithub({ bodies: { [TAG]: "Notes." }, failOn: "edit" }),
    });

    expect(code).toBe(1);
    expect(err).toEqual(["✗ gh refused the edit"]);
  });
});

describe("release-announce › gh", () => {
  const github = (execFile) => ghGithub("owner/repo", execFile);

  it("reads the body of a Release with gh and drops the line end gh adds", () => {
    const execFile = vi.fn(() => "Body.\n");

    expect(github(execFile).releaseBody("v1.0.0")).toBe("Body.");
    expect(execFile).toHaveBeenCalledWith(
      "gh",
      [
        "release",
        "view",
        "v1.0.0",
        "--repo",
        "owner/repo",
        "--json",
        "body",
        "--jq",
        ".body",
      ],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("gives null when the Release does not exist", () => {
    const execFile = vi.fn(() => {
      throw Object.assign(new Error("Command failed"), {
        stderr: "release not found\n",
      });
    });

    expect(github(execFile).releaseBody("v1.0.0")).toBeNull();
  });

  it.each([
    ["another stderr", { stderr: "HTTP 401: Bad credentials" }],
    ["no stderr", {}],
  ])("rethrows a failure of gh with %s", (_case, extra) => {
    const execFile = vi.fn(() => {
      throw Object.assign(new Error("Command failed: gh"), extra);
    });

    expect(() => github(execFile).releaseBody("v1.0.0")).toThrow(
      "Command failed: gh",
    );
  });

  it("edits the body of a Release with the body on stdin", () => {
    const execFile = vi.fn(() => "");

    github(execFile).editReleaseBody("v1.0.0", "New body.");

    expect(execFile).toHaveBeenCalledWith(
      "gh",
      [
        "release",
        "edit",
        "v1.0.0",
        "--repo",
        "owner/repo",
        "--notes-file",
        "-",
      ],
      expect.objectContaining({ input: "New body.", encoding: "utf8" }),
    );
  });
});

describe("release-announce › Telegram limits", () => {
  it("accepts a caption of exactly 1024 characters, counting the text Telegram shows", () => {
    const body = `**${"a".repeat(1022)}** &`;
    const [announcement] = buildAnnouncements({
      root: tempRoot({
        [PRERELEASE_FILE]: notesText({
          features: [{ en: body, pt: body, gif: GIF_A }],
        }),
      }),
      version: PRERELEASE,
      repository: REPO,
    });

    expect(announcement.posts[1].caption).toHaveLength(
      1024 + "<b></b>".length + "amp;".length,
    );
  });

  it("throws naming the ✨ item whose caption passes 1024 characters", () => {
    const body = "a".repeat(1024);

    expect(() =>
      buildAnnouncements({
        root: tempRoot({
          [PRERELEASE_FILE]: notesText({
            features: [{ en: `${body}b`, pt: "Curto.", gif: GIF_A }],
          }),
        }),
        version: PRERELEASE,
        repository: REPO,
      }),
    ).toThrow(
      `the ✨ item "✨ ${"a".repeat(37)}…" of ${PRE_EN} makes a caption of 1025 characters, over the 1024 Telegram takes`,
    );
  });

  it("throws naming the channel whose opening passes 4096 characters", () => {
    const long = "a".repeat(4096);

    expect(() =>
      buildAnnouncements({
        root: tempRoot({
          [PRERELEASE_FILE]: notesText({ summaryPt: [long] }),
        }),
        version: PRERELEASE,
        repository: REPO,
      }),
    ).toThrow(
      new RegExp(
        `^the opening of ${PRE_PT} has \\d+ characters, over the 4096 Telegram takes$`,
        "u",
      ),
    );
  });
});

describe("release-announce › --print", () => {
  it("prints every post of every channel with its method and GIF, without a token or the network", async () => {
    const { code, out, err, calls, sleeps } = await announceWith({
      args: ["--print"],
      env: { TELEGRAM_ANNOUNCE_TOKEN: undefined },
    });

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(sleeps).toEqual([]);
    expect(out).toEqual(
      PRERELEASE_ANNOUNCEMENTS.flatMap(({ chat, posts }) =>
        posts.map((post) =>
          post.method === "sendMessage"
            ? `${chat} · sendMessage\n${post.text}\n`
            : `${chat} · sendAnimation · ${post.animation} · reply to the opening\n${post.caption}\n`,
        ),
      ),
    );
  });

  it("marks each GIF line as a reply to the opening, and never the opening itself", async () => {
    const { out } = await announceWith({ args: ["--print"] });

    expect(out[0]).not.toContain("reply to the opening");
    expect(out[1].split("\n")[0]).toBe(
      `${PRE_EN} · sendAnimation · ${GIF_A} · reply to the opening`,
    );
  });

  it("links the Release of the project repository when GH_REPO is not set", async () => {
    const { code, out } = await announceWith({
      args: ["--print"],
      env: { GH_REPO: undefined },
    });

    expect(code).toBe(0);
    expect(out[0]).toContain(
      `<a href="https://github.com/pedromondek/better-claude-code-telegram/releases/tag/v${PRERELEASE}">`,
    );
  });

  it("reads the notes from the folder of --root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "announce-parent-"));
    const notes = join(parent, "other", PRERELEASE_FILE);

    mkdirSync(dirname(notes), { recursive: true });
    writeFileSync(notes, notesText());

    const { code, out, err } = await announceWith({
      args: ["--root", "other", "--print"],
      root: parent,
    });

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out).toHaveLength(6);
  });
});

describe("release-announce › posting", () => {
  it("downloads each GIF once before the first post, then posts every channel in turn as HTML and multipart", async () => {
    const { code, out, err, calls } = await announceWith();
    const posts = await sentPosts(calls);

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(calls.map(({ url }) => url)).toEqual([
      GIF_A,
      GIF_B,
      `${API}/sendMessage`,
      `${API}/sendAnimation`,
      `${API}/sendAnimation`,
      `${API}/getChat`,
      `${API}/pinChatMessage`,
      `${API}/sendMessage`,
      `${API}/sendAnimation`,
      `${API}/sendAnimation`,
      `${API}/getChat`,
      `${API}/pinChatMessage`,
    ]);
    expect(posts.slice(0, 3)).toEqual([
      {
        url: `${API}/sendMessage`,
        method: "sendMessage",
        chat: PRE_EN,
        text: PRERELEASE_ANNOUNCEMENTS[0].posts[0].text,
        parseMode: "HTML",
        contentType: "application/json",
      },
      {
        url: `${API}/sendAnimation`,
        method: "sendAnimation",
        chat: PRE_EN,
        caption: EN_CAPTIONS[GIF_A],
        parseMode: "HTML",
        replyParameters: { message_id: 101 },
        animation: {
          type: "image/gif",
          name: "animation.gif",
          bytes: `bytes of ${GIF_A}`,
        },
      },
      expect.objectContaining({ caption: EN_CAPTIONS[GIF_B] }),
    ]);
    expect(posts.slice(3).map(({ chat }) => chat)).toEqual([
      PRE_PT,
      PRE_PT,
      PRE_PT,
    ]);
    expect(posts[4].animation.bytes).toBe(`bytes of ${GIF_A}`);
    expect(calls[2].init.method).toBe("POST");
    expect(calls[3].init.method).toBe("POST");
    expect(out).toEqual([
      `✓ ${PRE_EN}: 3 posts, opening pinned`,
      `✓ ${PRE_PT}: 3 posts, opening pinned`,
    ]);
  });

  it("sends each GIF of a channel as a reply to the opening of that channel", async () => {
    const posts = await sentPosts((await announceWith()).calls);

    expect(
      posts.map(({ method, chat, replyParameters }) => ({
        method,
        chat,
        replyParameters,
      })),
    ).toEqual([
      { method: "sendMessage", chat: PRE_EN, replyParameters: undefined },
      {
        method: "sendAnimation",
        chat: PRE_EN,
        replyParameters: { message_id: 101 },
      },
      {
        method: "sendAnimation",
        chat: PRE_EN,
        replyParameters: { message_id: 101 },
      },
      { method: "sendMessage", chat: PRE_PT, replyParameters: undefined },
      {
        method: "sendAnimation",
        chat: PRE_PT,
        replyParameters: { message_id: 104 },
      },
      {
        method: "sendAnimation",
        chat: PRE_PT,
        replyParameters: { message_id: 104 },
      },
    ]);
  });

  it("keeps each set grouped on DRY_RUN=1, each GIF replying to the opening sent for its own channel", async () => {
    const posts = await sentPosts(
      (
        await announceWith({
          env: { DRY_RUN: "1", TELEGRAM_TEST_CHANNEL: TEST_CHANNEL },
        })
      ).calls,
    );

    expect(
      posts.map(({ chat, replyParameters, caption }) => ({
        chat,
        replyParameters,
        target: (caption ?? "").split("\n")[0],
      })),
    ).toEqual([
      { chat: TEST_CHANNEL, replyParameters: undefined, target: "" },
      {
        chat: TEST_CHANNEL,
        replyParameters: { message_id: 101 },
        target: `[${PRE_EN}]`,
      },
      {
        chat: TEST_CHANNEL,
        replyParameters: { message_id: 101 },
        target: `[${PRE_EN}]`,
      },
      { chat: TEST_CHANNEL, replyParameters: undefined, target: "" },
      {
        chat: TEST_CHANNEL,
        replyParameters: { message_id: 104 },
        target: `[${PRE_PT}]`,
      },
      {
        chat: TEST_CHANNEL,
        replyParameters: { message_id: 104 },
        target: `[${PRE_PT}]`,
      },
    ]);
  });

  it("fails before the GIFs when the answer to the opening has no message_id", async () => {
    const { code, err, calls, out } = await announceWith({
      fetch: {
        telegram: () => ({ status: 200, body: { ok: true, result: {} } }),
      },
    });

    expect(code).toBe(1);
    expect(calls.map(({ url }) => url)).toEqual([
      GIF_A,
      GIF_B,
      `${API}/sendMessage`,
    ]);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `✗ Telegram answered the opening of ${PRE_EN} without a message_id, so its GIFs cannot reply to it${UNSURE_FIRST_OPENING}`,
    ]);
  });

  it("fails before the GIFs when the answer to the opening has no result", async () => {
    const { code, err } = await announceWith({
      fetch: { telegram: () => ({ status: 200, body: { ok: true } }) },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ Telegram answered the opening of ${PRE_EN} without a message_id, so its GIFs cannot reply to it${UNSURE_FIRST_OPENING}`,
    ]);
  });

  it("waits a second between posts of the same channel, and not before the first post of the next", async () => {
    const { sleeps } = await announceWith();

    expect(sleeps).toEqual([1000, 1000, 1000, 1000]);
  });

  it("fails on DRY_RUN=1 when the channel line pushes a caption over 1024, before any request", async () => {
    const root = tempRoot({
      [PRERELEASE_FILE]: notesText({
        features: [{ en: "a".repeat(1018), pt: "Curto.", gif: GIF_A }],
      }),
    });
    const dry = await announceWith({
      root,
      env: { DRY_RUN: "1", TELEGRAM_TEST_CHANNEL: TEST_CHANNEL },
    });
    const real = await announceWith({ root });

    expect(dry.code).toBe(1);
    expect(dry.calls).toEqual([]);
    expect(dry.err).toEqual([
      `✗ the dry run of ${PRE_EN} makes a caption of 1043 characters, over the 1024 Telegram takes`,
    ]);
    expect(real.code).toBe(0);
  });

  it("fails on DRY_RUN=1 when the channel line pushes an opening over 4096, before any request", async () => {
    const files = (bullet) => ({
      [PRERELEASE_FILE]: notesText({ summaryPt: [bullet] }),
    });
    const overflow = (() => {
      try {
        buildAnnouncements({
          root: tempRoot(files("a".repeat(4096))),
          version: PRERELEASE,
          repository: REPO,
        });
      } catch (error) {
        return Number(/has (\d+) characters/u.exec(error.message)[1]);
      }

      return 0;
    })();
    const root = tempRoot(files("a".repeat(4096 * 2 - overflow - 5)));
    const dry = await announceWith({
      root,
      env: { DRY_RUN: "1", TELEGRAM_TEST_CHANNEL: TEST_CHANNEL },
    });
    const real = await announceWith({ root });

    expect(dry.code).toBe(1);
    expect(dry.calls).toEqual([]);
    expect(dry.err).toEqual([
      `✗ the dry run of ${PRE_PT} makes an opening of ${4096 - 5 + PRE_PT.length + 3} characters, over the 4096 Telegram takes`,
    ]);
    expect(real.code).toBe(0);
  });

  it("sends every post to TELEGRAM_TEST_CHANNEL on DRY_RUN=1, each under a first line naming its channel", async () => {
    const { code, out, calls, sleeps } = await announceWith({
      env: { DRY_RUN: "1", TELEGRAM_TEST_CHANNEL: TEST_CHANNEL },
    });
    const posts = await sentPosts(calls);

    expect(code).toBe(0);
    expect(posts.map(({ chat }) => chat)).toEqual(
      Array.from({ length: 6 }, () => TEST_CHANNEL),
    );
    expect(posts[0].text).toBe(
      `[${PRE_EN}]\n${PRERELEASE_ANNOUNCEMENTS[0].posts[0].text}`,
    );
    expect(posts[1].caption).toBe(`[${PRE_EN}]\n${EN_CAPTIONS[GIF_A]}`);
    expect(posts[3].text).toBe(
      `[${PRE_PT}]\n${PRERELEASE_ANNOUNCEMENTS[1].posts[0].text}`,
    );
    expect(sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(out).toEqual([
      `✓ ${PRE_EN}: 3 posts in ${TEST_CHANNEL}, opening pinned`,
      `✓ ${PRE_PT}: 3 posts in ${TEST_CHANNEL}, opening pinned`,
    ]);
  });

  it("posts a stable version on the four channels, the stable ones first", async () => {
    const { code, out } = await announceWith({
      root: tempRoot(stableFiles()),
      env: { VERSION: STABLE },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `✓ ${STABLE_EN}: 4 posts, opening pinned`,
      `✓ ${STABLE_PT}: 4 posts, opening pinned`,
      `✓ ${PRE_EN}: 2 posts, opening pinned`,
      `✓ ${PRE_PT}: 2 posts, opening pinned`,
    ]);
  });

  it("counts a single post in the singular", async () => {
    const { out } = await announceWith({
      root: tempRoot(
        stableFiles({
          "docs/releases/0.3.0/rc.1.md": notesText({ features: [VOICE] }),
        }),
      ),
      env: { VERSION: STABLE },
    });

    expect(out.slice(2)).toEqual([
      `✓ ${PRE_EN}: 1 post, opening pinned`,
      `✓ ${PRE_PT}: 1 post, opening pinned`,
    ]);
  });
});

describe("release-announce › Telegram answers", () => {
  it("waits the retry_after of a 429 and posts again", async () => {
    const { code, calls, sleeps } = await announceWith({
      fetch: {
        telegram: (count) =>
          count === 1
            ? {
                status: 429,
                body: {
                  ok: false,
                  description: "Too Many Requests: retry after 5",
                  parameters: { retry_after: 5 },
                },
              }
            : sentWithId(count),
      },
    });

    expect(code).toBe(0);
    expect(sleeps[0]).toBe(5000);
    expect(
      calls.filter(({ url }) => url === `${API}/sendMessage`),
    ).toHaveLength(3);
  });

  it("fails with the description after 3 retries of a 429", async () => {
    const { code, err, calls, sleeps, out } = await announceWith({
      fetch: {
        telegram: () => ({
          status: 429,
          body: {
            ok: false,
            description: "Too Many Requests: retry after 2",
            parameters: { retry_after: 2 },
          },
        }),
      },
    });

    expect(code).toBe(1);
    expect(telegramCalls(calls)).toHaveLength(4);
    expect(sleeps).toEqual([2000, 2000, 2000]);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `✗ Telegram answered 429 to sendMessage for ${PRE_EN}: Too Many Requests: retry after 2`,
    ]);
  });

  it("fails without retrying a 429 that has no retry_after", async () => {
    const { code, err, calls } = await announceWith({
      fetch: {
        telegram: () => ({
          status: 429,
          body: { ok: false, description: "Too Many Requests" },
        }),
      },
    });

    expect(code).toBe(1);
    expect(telegramCalls(calls)).toHaveLength(1);
    expect(err).toEqual([
      `✗ Telegram answered 429 to sendMessage for ${PRE_EN}: Too Many Requests`,
    ]);
  });

  it("stops at the first other error with the Telegram description", async () => {
    const { code, err, calls } = await announceWith({
      fetch: {
        telegram: () => ({
          status: 400,
          body: { ok: false, description: "Bad Request: chat not found" },
        }),
      },
    });

    expect(code).toBe(1);
    expect(telegramCalls(calls)).toHaveLength(1);
    expect(err).toEqual([
      `✗ Telegram answered 400 to sendMessage for ${PRE_EN}: Bad Request: chat not found`,
    ]);
  });

  it("fails on an answer of 200 whose ok is not true", async () => {
    const { code, err } = await announceWith({
      fetch: {
        telegram: () => ({
          status: 200,
          body: { ok: false, description: "Odd" },
        }),
      },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ Telegram answered 200 to sendMessage for ${PRE_EN}: Odd${UNSURE_FIRST_OPENING}`,
    ]);
  });

  it.each([["<html>bad gateway</html>"], ["null"]])(
    "falls back to the HTTP status text when the answer is not a JSON object (%s)",
    async (body) => {
      const { code, err } = await announceWith({
        fetch: {
          telegram: () => ({ status: 502, statusText: "Bad Gateway", body }),
        },
      });

      expect(code).toBe(1);
      expect(err).toEqual([
        `✗ Telegram answered 502 to sendMessage for ${PRE_EN}: Bad Gateway`,
      ]);
    },
  );

  it("fails naming the GIF that does not download, before any post", async () => {
    const { code, err, calls } = await announceWith({
      fetch: { gifStatus: (url) => (url === GIF_A ? 404 : 200) },
    });

    expect(code).toBe(1);
    expect(calls.map(({ url }) => url)).toEqual([GIF_A, GIF_B]);
    expect(err).toEqual([
      `✗ could not download the animation ${GIF_A} for ${PRE_EN}: 404`,
    ]);
  });

  it("fails naming the GIF whose download cannot reach its host, before any post", async () => {
    const { code, err, calls } = await announceWith({
      fetch: {
        failWith: new TypeError("getaddrinfo ENOTFOUND github.com"),
        failOn: (url) => url === GIF_B,
      },
    });

    expect(code).toBe(1);
    expect(telegramCalls(calls)).toEqual([]);
    expect(err).toEqual([
      `✗ could not download the animation ${GIF_B} for ${PRE_EN}: getaddrinfo ENOTFOUND github.com`,
    ]);
  });

  it("fails with the value a download throws when it is not an Error", async () => {
    const { code, err } = await announceWith({
      fetch: { failWith: "aborted", failOn: (url) => url === GIF_A },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ could not download the animation ${GIF_A} for ${PRE_EN}: aborted`,
    ]);
  });

  it("fails naming the pt-br channel whose MP4 does not download, before posting the en-us one", async () => {
    const { code, err, calls, out } = await announceWith({
      root: tempRoot({
        [PRERELEASE_FILE]: notesText({
          features: [{ ...QUESTIONS, ptVideo: VIDEO_PT }],
        }),
      }),
      fetch: { gifStatus: (url) => (url === VIDEO_PT ? 502 : 200) },
    });

    expect(code).toBe(1);
    expect(calls.map(({ url }) => url)).toEqual([GIF_A, VIDEO_PT]);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `✗ could not download the animation ${VIDEO_PT} for ${PRE_PT}: 502`,
    ]);
  });

  it("fails naming the animation over the 50 MB Telegram takes, before any post", async () => {
    const limit = 50 * 1024 * 1024;
    const { code, err, calls } = await announceWith({
      fetch: {
        gifBody: (url) =>
          url === GIF_B ? new Uint8Array(limit + 1) : `bytes of ${url}`,
      },
    });

    expect(code).toBe(1);
    expect(calls.map(({ url }) => url)).toEqual([GIF_A, GIF_B]);
    expect(err).toEqual([
      `✗ the animation ${GIF_B} for ${PRE_EN} has ${limit + 1} bytes, over the ${limit} Telegram takes`,
    ]);
  });

  it("uploads an animation of exactly 50 MB", async () => {
    const limit = 50 * 1024 * 1024;
    const { code, calls } = await announceWith({
      fetch: {
        gifBody: (url) =>
          url === GIF_B ? new Uint8Array(limit) : `bytes of ${url}`,
      },
    });
    const posts = await sentPosts(calls);

    expect(code).toBe(0);
    expect(posts[2].animation.bytes).toHaveLength(limit);
  });

  it("hides the token when the request itself fails with the URL in the message", async () => {
    const { code, err } = await announceWith({
      fetch: {
        failWith: new TypeError(`fetch failed for ${API}/sendMessage`),
        failOn: (url) => url.startsWith(API),
      },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ could not reach Telegram for sendMessage to ${PRE_EN}: fetch failed for https://api.telegram.org/bot***/sendMessage${UNSURE_FIRST_OPENING}`,
    ]);
    expect(err.join("\n")).not.toContain(TOKEN);
  });

  it("hides the token in a Telegram description that echoes it", async () => {
    const { err } = await announceWith({
      fetch: {
        telegram: () => ({
          status: 401,
          body: { ok: false, description: `Unauthorized ${TOKEN}` },
        }),
      },
    });

    expect(err).toEqual([
      `✗ Telegram answered 401 to sendMessage for ${PRE_EN}: Unauthorized ***`,
    ]);
  });
});

describe("release-announce › pin", () => {
  const V = `v${PRERELEASE}`;
  const DRY = { DRY_RUN: "1", TELEGRAM_TEST_CHANNEL: TEST_CHANNEL };

  it("pins the opening of each channel after its last post, with no notification", async () => {
    const { code, out, calls } = await announceWith();

    expect(code).toBe(0);
    expect(pinCalls(calls)).toEqual([
      { method: "getChat", chat: PRE_EN },
      {
        method: "pinChatMessage",
        chat: PRE_EN,
        messageId: 101,
        disableNotification: true,
      },
      { method: "getChat", chat: PRE_PT },
      {
        method: "pinChatMessage",
        chat: PRE_PT,
        messageId: 104,
        disableNotification: true,
      },
    ]);
    expect(methodOf(telegramCalls(calls).at(3).url)).toBe("getChat");
    expect(out).toEqual([
      `✓ ${PRE_EN}: 3 posts, opening pinned`,
      `✓ ${PRE_PT}: 3 posts, opening pinned`,
    ]);
  });

  it("unpins the opening of the previous version before pinning the new one", async () => {
    const { calls } = await announceWith({
      fetch: { pinning: pinnedIn(openingOf(55)) },
    });

    expect(pinCalls(calls).slice(0, 3)).toEqual([
      { method: "getChat", chat: PRE_EN },
      { method: "unpinChatMessage", chat: PRE_EN, messageId: 55 },
      {
        method: "pinChatMessage",
        chat: PRE_EN,
        messageId: 101,
        disableNotification: true,
      },
    ]);
  });

  it("keeps the pinned opening of a newer version and says so", async () => {
    const { code, out, calls } = await announceWith({
      env: { ANNOUNCE_RESUME: `${V},${PRE_EN}=101:3,${PRE_PT}=104:3` },
      fetch: { pinning: pinnedIn(openingOf(120, "0.3.0-alpha.2")) },
    });

    expect(code).toBe(0);
    expect(pinCalls(calls)).toEqual([
      { method: "getChat", chat: PRE_EN },
      { method: "getChat", chat: PRE_PT },
    ]);
    expect(out).toEqual([
      `✓ ${PRE_EN}: opening kept, v0.3.0-alpha.2 is pinned`,
      `✓ ${PRE_PT}: opening kept, v0.3.0-alpha.2 is pinned`,
    ]);
  });

  it("says the opening was kept after posting when a newer one is pinned", async () => {
    const { code, out } = await announceWith({
      fetch: { pinning: pinnedIn(openingOf(120, "1.0.0")) },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `✓ ${PRE_EN}: 3 posts, opening kept, v1.0.0 is pinned`,
      `✓ ${PRE_PT}: 3 posts, opening kept, v1.0.0 is pinned`,
    ]);
  });

  it("recognizes the version of an opening by its own Release link, the last one, after the included versions", async () => {
    const link = (version) => ({
      type: "text_link",
      url: `https://github.com/${REPO}/releases/tag/v${version}`,
    });
    const { out, calls } = await announceWith({
      env: { VERSION: ALPHA_2 },
      root: tempRoot({ [folderFile("alpha.2")]: notesText() }),
      fetch: {
        pinning: pinnedIn({
          pinned_message: {
            message_id: 55,
            entities: [link(ALPHA_1), link("0.3.0-alpha.0"), link(BETA)],
          },
        }),
      },
    });

    expect(out).toEqual([
      `✓ ${PRE_EN}: 3 posts, opening kept, v${BETA} is pinned`,
      `✓ ${PRE_PT}: 3 posts, opening kept, v${BETA} is pinned`,
    ]);
    expect(
      pinCalls(calls).filter(({ method }) => method !== "getChat"),
    ).toEqual([]);
  });

  it("recognizes the last link that is a version when a later link is not one", async () => {
    const { out } = await announceWith({
      env: { VERSION: ALPHA_2 },
      root: tempRoot({ [folderFile("alpha.2")]: notesText() }),
      fetch: {
        pinning: pinnedIn({
          pinned_message: {
            message_id: 55,
            entities: [
              {
                type: "text_link",
                url: `https://github.com/${REPO}/releases/tag/v${BETA}`,
              },
              {
                type: "text_link",
                url: `https://github.com/${REPO}/releases/tag/vnext`,
              },
            ],
          },
        }),
      },
    });

    expect(out[0]).toBe(
      `✓ ${PRE_EN}: 3 posts, opening kept, v${BETA} is pinned`,
    );
  });

  it("replaces another opening of the same version", async () => {
    const { calls } = await announceWith({
      fetch: { pinning: pinnedIn(openingOf(90, PRERELEASE)) },
    });

    expect(pinCalls(calls).slice(0, 3)).toEqual([
      { method: "getChat", chat: PRE_EN },
      { method: "unpinChatMessage", chat: PRE_EN, messageId: 90 },
      {
        method: "pinChatMessage",
        chat: PRE_EN,
        messageId: 101,
        disableNotification: true,
      },
    ]);
  });

  it.each([
    [
      "a message without links",
      { pinned_message: { message_id: 55, text: "Welcome" } },
    ],
    [
      "a Release link of this repository without a version",
      {
        pinned_message: {
          message_id: 55,
          entities: [
            {
              type: "text_link",
              url: `https://github.com/${REPO}/releases/tag/vnext`,
            },
          ],
        },
      },
    ],
    [
      "a link to another repository",
      {
        pinned_message: {
          message_id: 55,
          entities: [
            {
              type: "text_link",
              url: "https://github.com/other/repo/releases/tag/v1.0.0",
            },
          ],
        },
      },
    ],
    ["no pinned message", {}],
  ])("keeps a pinned message with %s", async (_case, pinned) => {
    const { calls } = await announceWith({
      fetch: { pinning: pinnedIn(pinned) },
    });

    expect(
      pinCalls(calls).filter(({ method }) => method === "unpinChatMessage"),
    ).toEqual([]);
    expect(
      pinCalls(calls).filter(({ method }) => method === "pinChatMessage"),
    ).toHaveLength(2);
  });

  it("does not pin again an opening that is already the pinned one", async () => {
    const { code, out, calls } = await announceWith({
      env: { ANNOUNCE_RESUME: `${V},${PRE_EN}=done,${PRE_PT}=104:3` },
      fetch: { pinning: pinnedIn(openingOf(104, PRERELEASE)) },
    });

    expect(code).toBe(0);
    expect(pinCalls(calls)).toEqual([{ method: "getChat", chat: PRE_PT }]);
    expect(out).toEqual([
      `✓ ${PRE_EN}: posted before`,
      `✓ ${PRE_PT}: opening pinned`,
    ]);
  });

  it("only pins the opening when the resume says every post of the channel went", async () => {
    const { code, out, calls } = await announceWith({
      env: { ANNOUNCE_RESUME: `${V},${PRE_EN}=done,${PRE_PT}=104:3` },
    });

    expect(code).toBe(0);
    expect(await sentPosts(calls)).toEqual([]);
    expect(pinCalls(calls)).toEqual([
      { method: "getChat", chat: PRE_PT },
      {
        method: "pinChatMessage",
        chat: PRE_PT,
        messageId: 104,
        disableNotification: true,
      },
    ]);
    expect(out).toEqual([
      `✓ ${PRE_EN}: posted before`,
      `✓ ${PRE_PT}: opening pinned`,
    ]);
  });

  it("tells the resume that only pins when Telegram rejects the pin", async () => {
    const { code, err } = await announceWith({
      fetch: {
        pinning: (method) =>
          method === "pinChatMessage"
            ? {
                status: 400,
                body: { ok: false, description: "not enough rights" },
              }
            : nothingPinned(method),
      },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ Telegram answered 400 to pinChatMessage for ${PRE_EN}: not enough rights; to post only what is left, dispatch announce-release.yml with resume: ${V},${PRE_EN}=101:3`,
    ]);
  });

  it("tells the same resume when the answer to the pin is lost, since pinning again changes nothing", async () => {
    const { err } = await announceWith({
      fetch: {
        pinning: (method) =>
          method === "pinChatMessage"
            ? { status: 200, bodyError: new TypeError("terminated") }
            : nothingPinned(method),
      },
    });

    expect(err).toEqual([
      `✗ could not read the answer of Telegram to pinChatMessage for ${PRE_EN}: terminated; to post only what is left, dispatch announce-release.yml with resume: ${V},${PRE_EN}=101:3`,
    ]);
  });

  it("pins in TELEGRAM_TEST_CHANNEL on DRY_RUN=1", async () => {
    const { out, calls } = await announceWith({ env: DRY });

    expect(
      pinCalls(calls).filter(({ method }) => method === "pinChatMessage"),
    ).toEqual([
      expect.objectContaining({ chat: TEST_CHANNEL, messageId: 101 }),
      expect.objectContaining({ chat: TEST_CHANNEL, messageId: 104 }),
    ]);
    expect(out).toEqual([
      `✓ ${PRE_EN}: 3 posts in ${TEST_CHANNEL}, opening pinned`,
      `✓ ${PRE_PT}: 3 posts in ${TEST_CHANNEL}, opening pinned`,
    ]);
  });
});

describe("release-announce › resume", () => {
  const V = `v${PRERELEASE}`;
  const DRY = { DRY_RUN: "1", TELEGRAM_TEST_CHANNEL: TEST_CHANNEL };
  const rejectCall = (failing) => (count) =>
    count === failing
      ? { status: 400, body: { ok: false, description: "Bad Request" } }
      : sentWithId(count);

  it("tells the resume of the channel whose GIF Telegram rejects after its opening", async () => {
    const { code, err, out } = await announceWith({
      fetch: { telegram: rejectCall(2) },
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `✗ Telegram answered 400 to sendAnimation for ${PRE_EN}: Bad Request; to post only what is left, dispatch announce-release.yml with resume: ${V},${PRE_EN}=101:1`,
    ]);
  });

  it("names the test channel in the resume of a dry run", async () => {
    const { err } = await announceWith({
      env: DRY,
      fetch: { telegram: rejectCall(2) },
    });

    expect(err).toEqual([
      `✗ Telegram answered 400 to sendAnimation for ${PRE_EN}: Bad Request; to post only what is left, dispatch announce-release.yml with resume: ${V},test=${TEST_CHANNEL},${PRE_EN}=101:1`,
    ]);
  });

  it("names the finished channels in the resume of a rejection on the next channel", async () => {
    const { err } = await announceWith({
      fetch: { telegram: rejectCall(6) },
    });

    expect(err).toEqual([
      `✗ Telegram answered 400 to sendAnimation for ${PRE_PT}: Bad Request; to post only what is left, dispatch announce-release.yml with resume: ${V},${PRE_EN}=done,${PRE_PT}=104:2`,
    ]);
  });

  it("gives no resume when Telegram rejects the first opening, since nothing was posted", async () => {
    const { err } = await announceWith({
      fetch: { telegram: rejectCall(1) },
    });

    expect(err).toEqual([
      `✗ Telegram answered 400 to sendMessage for ${PRE_EN}: Bad Request`,
    ]);
  });

  it("posts only what is left on ANNOUNCE_RESUME, each GIF replying to the given opening", async () => {
    const { code, out, calls } = await announceWith({
      env: { ANNOUNCE_RESUME: `${V},${PRE_EN}=done,${PRE_PT}=104:2` },
    });
    const posts = await sentPosts(calls);

    expect(code).toBe(0);
    expect(calls.map(({ url }) => url)).toEqual([
      GIF_B,
      `${API}/sendAnimation`,
      `${API}/getChat`,
      `${API}/pinChatMessage`,
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        chat: PRE_PT,
        caption: PT_CAPTIONS[GIF_B],
        replyParameters: { message_id: 104 },
      }),
    ]);
    expect(out).toEqual([
      `✓ ${PRE_EN}: posted before`,
      `✓ ${PRE_PT}: 1 post, opening pinned`,
    ]);
  });

  it("carries the finished and the given progress into the resume of a rejection on the resumed run", async () => {
    const { code, err } = await announceWith({
      env: { ANNOUNCE_RESUME: `${V},${PRE_EN}=done,${PRE_PT}=104:1` },
      fetch: { telegram: rejectCall(2) },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ Telegram answered 400 to sendAnimation for ${PRE_PT}: Bad Request; to post only what is left, dispatch announce-release.yml with resume: ${V},${PRE_EN}=done,${PRE_PT}=104:2`,
    ]);
  });

  it("keeps a channel that ANNOUNCE_RESUME does not name for a full post", async () => {
    const { out, calls } = await announceWith({
      env: { ANNOUNCE_RESUME: `${V},${PRE_EN}=done` },
    });

    expect(await sentPosts(calls)).toHaveLength(3);
    expect(pinCalls(calls)).toHaveLength(2);
    expect(out).toEqual([
      `✓ ${PRE_EN}: posted before`,
      `✓ ${PRE_PT}: 3 posts, opening pinned`,
    ]);
  });

  it("gives both resumes when the answer to a GIF is lost, since Telegram may have taken it", async () => {
    const { code, err } = await announceWith({
      fetch: {
        telegram: (count) =>
          count === 2
            ? { status: 200, bodyError: new TypeError("terminated") }
            : sentWithId(count),
      },
    });

    expect(code).toBe(1);
    expect(err).toEqual([
      `✗ could not read the answer of Telegram to sendAnimation for ${PRE_EN}: terminated; Telegram may have taken it: if it shows in ${PRE_EN}, dispatch announce-release.yml with resume: ${V},${PRE_EN}=101:2; if not, resume: ${V},${PRE_EN}=101:1`,
    ]);
  });

  it("points at the test channel to look for the post whose answer is lost on a dry run", async () => {
    const { err } = await announceWith({
      env: DRY,
      fetch: {
        telegram: (count) =>
          count === 2
            ? { status: 200, bodyError: new TypeError("terminated") }
            : sentWithId(count),
      },
    });

    expect(err).toEqual([
      `✗ could not read the answer of Telegram to sendAnimation for ${PRE_EN}: terminated; Telegram may have taken it: if it shows in ${TEST_CHANNEL} under [${PRE_EN}], dispatch announce-release.yml with resume: ${V},test=${TEST_CHANNEL},${PRE_EN}=101:2; if not, resume: ${V},test=${TEST_CHANNEL},${PRE_EN}=101:1`,
    ]);
  });

  it("leaves only the pin in the shown resume when the lost answer is of the last post of a channel", async () => {
    const { err } = await announceWith({
      fetch: {
        telegram: (count) =>
          count === 3
            ? { status: 200, bodyError: new TypeError("terminated") }
            : sentWithId(count),
      },
    });

    expect(err).toEqual([
      `✗ could not read the answer of Telegram to sendAnimation for ${PRE_EN}: terminated; Telegram may have taken it: if it shows in ${PRE_EN}, dispatch announce-release.yml with resume: ${V},${PRE_EN}=101:3; if not, resume: ${V},${PRE_EN}=101:2`,
    ]);
  });

  it("asks for the opening id when the answer to the opening of the next channel is lost", async () => {
    const { err } = await announceWith({
      fetch: {
        telegram: (count) =>
          count === 4
            ? { status: 502, bodyError: new TypeError("terminated") }
            : sentWithId(count),
      },
    });

    expect(err).toEqual([
      `✗ could not read the answer of Telegram to sendMessage for ${PRE_PT}: terminated; Telegram may have taken it: if it shows in ${PRE_PT}, dispatch announce-release.yml with resume: ${V},${PRE_EN}=done,${PRE_PT}=<opening id>:1 (the opening id is the number at the end of its t.me link); if not, resume: ${V},${PRE_EN}=done`,
    ]);
  });

  it("asks for the opening id to pin when the lost answer is of the only post of a channel", async () => {
    const { err } = await announceWith({
      root: tempRoot(
        stableFiles({
          "docs/releases/0.3.0/rc.1.md": notesText({ features: [VOICE] }),
        }),
      ),
      env: { VERSION: STABLE },
      fetch: {
        telegram: (count) =>
          count === 9
            ? { status: 200, bodyError: new TypeError("terminated") }
            : sentWithId(count),
      },
    });
    const finished = `v${STABLE},${STABLE_EN}=done,${STABLE_PT}=done`;

    expect(err).toEqual([
      `✗ could not read the answer of Telegram to sendMessage for ${PRE_EN}: terminated; Telegram may have taken it: if it shows in ${PRE_EN}, dispatch announce-release.yml with resume: ${finished},${PRE_EN}=<opening id>:1 (the opening id is the number at the end of its t.me link); if not, resume: ${finished}`,
    ]);
  });

  it("takes the resume of a dry run in the same test channel", async () => {
    const { code, out } = await announceWith({
      env: {
        ...DRY,
        ANNOUNCE_RESUME: `${V},test=${TEST_CHANNEL},${PRE_EN}=done`,
      },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `✓ ${PRE_EN}: posted before`,
      `✓ ${PRE_PT}: 3 posts in ${TEST_CHANNEL}, opening pinned`,
    ]);
  });

  it.each([
    [{}, `${PRE_EN}=done`, `the cursor does not start with the version, ${V}`],
    [{}, `v0.2.0,${PRE_EN}=done`, `the cursor is of v0.2.0, not of ${V}`],
    [
      {},
      `${V},test=${TEST_CHANNEL},${PRE_EN}=done`,
      `the cursor is of a dry run in ${TEST_CHANNEL}, not of the public channels`,
    ],
    [
      DRY,
      `${V},${PRE_EN}=done`,
      `the cursor is of the public channels, not of a dry run in ${TEST_CHANNEL}`,
    ],
    [
      DRY,
      `${V},test=@other_test,${PRE_EN}=done`,
      `the cursor is of a dry run in @other_test, not of a dry run in ${TEST_CHANNEL}`,
    ],
  ])(
    "refuses a resume of another version or destination before any request (%j %s)",
    async (env, resume, reason) => {
      const { code, err, calls } = await announceWith({
        env: { ...env, ANNOUNCE_RESUME: resume },
      });

      expect(code).toBe(1);
      expect(calls).toEqual([]);
      expect(err).toEqual([`✗ ANNOUNCE_RESUME: ${reason}`]);
    },
  );

  it.each([
    ["x", '"x" is not <channel>=done or <channel>=<opening id>:<posts sent>'],
    [
      `${PRE_EN}=abc:1`,
      `"${PRE_EN}=abc:1" is not <channel>=done or <channel>=<opening id>:<posts sent>`,
    ],
    [`@other=done`, "@other is not a channel of this version"],
    [`${PRE_EN}=101:4`, `${PRE_EN} has 3 posts, so 4 cannot be left to post`],
    [`${PRE_EN}=101:0`, `${PRE_EN} has 3 posts, so 0 cannot be left to post`],
  ])(
    "refuses the ANNOUNCE_RESUME entry %s before any request",
    async (entry, reason) => {
      const { code, err, calls } = await announceWith({
        env: { ANNOUNCE_RESUME: `${V},${entry}` },
      });

      expect(code).toBe(1);
      expect(calls).toEqual([]);
      expect(err).toEqual([`✗ ANNOUNCE_RESUME: ${reason}`]);
    },
  );
});

describe("release-announce › run", () => {
  it("refuses to post without TELEGRAM_ANNOUNCE_TOKEN", async () => {
    const { code, err, calls } = await announceWith({
      env: { TELEGRAM_ANNOUNCE_TOKEN: "" },
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(err).toEqual([
      "✗ TELEGRAM_ANNOUNCE_TOKEN is required to post; --print shows the posts without it",
    ]);
  });

  it("refuses DRY_RUN=1 without TELEGRAM_TEST_CHANNEL", async () => {
    const { code, err, calls } = await announceWith({
      env: { DRY_RUN: "1", TELEGRAM_TEST_CHANNEL: "" },
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(err).toEqual([
      "✗ DRY_RUN=1 posts to TELEGRAM_TEST_CHANNEL, which is not set",
    ]);
  });

  it("posts to the real channels when DRY_RUN is not 1", async () => {
    const { calls } = await announceWith({
      env: { DRY_RUN: "", TELEGRAM_TEST_CHANNEL: TEST_CHANNEL },
    });
    const posts = await sentPosts(calls);

    expect(posts[0].chat).toBe(PRE_EN);
  });

  it.each([[["--print"]], [[]]])(
    "refuses to run without VERSION (%j)",
    async (args) => {
      const { code, err } = await announceWith({
        args,
        env: { VERSION: "" },
      });

      expect(code).toBe(1);
      expect(err).toEqual(["✗ VERSION is required"]);
    },
  );

  it("refuses a VERSION that is not a version", async () => {
    const { code, err } = await announceWith({
      args: ["--print"],
      env: { VERSION: "next" },
    });

    expect(code).toBe(1);
    expect(err).toEqual(["✗ invalid version: next"]);
  });

  it.each([
    [["x"]],
    [["--root"]],
    [["--print", "--root"]],
    [["--fix"]],
    [["link", "--print"]],
    [["--print", "link"]],
  ])("a usage error exits 2 (%j)", async (args) => {
    const { code, err, calls } = await announceWith({ args });

    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(err).toEqual([
      "usage: npm run release:announce -- [--print] [--root <folder>] | link (version in VERSION)",
    ]);
  });

  it("is the release:announce npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["release:announce"]).toBe(
      "node scripts/release-announce.mjs",
    );
  });
});
