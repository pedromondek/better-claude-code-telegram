import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildAnnouncements,
  parseNotes,
  run,
  toTelegramHtml,
} from "../release-announce.mjs";
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
          gif: null,
        },
      ],
    }),
    "docs/releases/0.3.0/draft.md": notesText({ features: [VOICE] }),
    ...extra,
  };
}

function opening({ marker, title, bullets, version, language, tag }) {
  const english = language === "en-us";

  return [
    `${marker} <b>${title}</b>`,
    "",
    ...(bullets.length > 0 ? [...bullets, ""] : []),
    `<a href="https://github.com/${REPO}/releases/tag/v${version}">${english ? "Release notes" : "Notas da versão"}</a>`,
    `${english ? "Install" : "Instalar"}: <code>npx @pedromondek/better-claude-code-telegram@${tag}</code>`,
  ].join("\n");
}

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

function fakeFetch({
  telegram = sentWithId,
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
      const count = calls.filter((call) =>
        call.url.startsWith("https://api.telegram.org/"),
      ).length;
      const answer = telegram(count);

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

async function announceWith({
  args = [],
  env = {},
  root = tempRoot(),
  fetch: fetchOptions = {},
} = {}) {
  const clock = fakeSleep();
  const { fetch, calls } = fakeFetch(fetchOptions);
  const out = [];
  const err = [];
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
  });

  return { code, out, err, calls, sleeps: clock.sleeps };
}

const telegramCalls = (calls) =>
  calls.filter((call) => call.url.startsWith("https://api.telegram.org/"));

async function sentPosts(calls) {
  const posts = [];

  for (const { url, init } of telegramCalls(calls)) {
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
            tag: "latest",
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
            tag: "latest",
          }),
        },
        ...animations(PT_CAPTIONS, [GIF_A, GIF_B, GIF_C]),
      ],
    });
  });

  it("tells the pre-release channels the version is stable, with only the ✨ items no pre-release of the folder had, by GIF and then by text", () => {
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
            tag: "latest",
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
            tag: "latest",
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
          `<a href="https://github.com/${REPO}/releases/tag/v${STABLE}">Release notes</a>`,
          "Install: <code>npx @pedromondek/better-claude-code-telegram@latest</code>",
        ].join("\n"),
      },
    ]);
    expect(portuguese.posts).toEqual([
      {
        method: "sendMessage",
        text: [
          `✅ <b>${STABLE}</b> está estável`,
          "",
          `<a href="https://github.com/${REPO}/releases/tag/v${STABLE}">Notas da versão</a>`,
          "Instalar: <code>npx @pedromondek/better-claude-code-telegram@latest</code>",
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
      `${API}/sendMessage`,
      `${API}/sendAnimation`,
      `${API}/sendAnimation`,
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
    expect(out).toEqual([`✓ ${PRE_EN}: 3 posts`, `✓ ${PRE_PT}: 3 posts`]);
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
      `✓ ${PRE_EN}: 3 posts in ${TEST_CHANNEL}`,
      `✓ ${PRE_PT}: 3 posts in ${TEST_CHANNEL}`,
    ]);
  });

  it("posts a stable version on the four channels, the stable ones first", async () => {
    const { code, out } = await announceWith({
      root: tempRoot(stableFiles()),
      env: { VERSION: STABLE },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `✓ ${STABLE_EN}: 4 posts`,
      `✓ ${STABLE_PT}: 4 posts`,
      `✓ ${PRE_EN}: 2 posts`,
      `✓ ${PRE_PT}: 2 posts`,
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
      `✓ ${PRE_EN}: 1 post`,
      `✓ ${PRE_PT}: 1 post`,
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
    ]);
    expect(posts).toEqual([
      expect.objectContaining({
        chat: PRE_PT,
        caption: PT_CAPTIONS[GIF_B],
        replyParameters: { message_id: 104 },
      }),
    ]);
    expect(out).toEqual([`✓ ${PRE_EN}: posted before`, `✓ ${PRE_PT}: 1 post`]);
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

    expect(telegramCalls(calls)).toHaveLength(3);
    expect(out).toEqual([`✓ ${PRE_EN}: posted before`, `✓ ${PRE_PT}: 3 posts`]);
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

  it("names the channel as done in the shown resume when the lost answer is of its last post", async () => {
    const { err } = await announceWith({
      fetch: {
        telegram: (count) =>
          count === 3
            ? { status: 200, bodyError: new TypeError("terminated") }
            : sentWithId(count),
      },
    });

    expect(err).toEqual([
      `✗ could not read the answer of Telegram to sendAnimation for ${PRE_EN}: terminated; Telegram may have taken it: if it shows in ${PRE_EN}, dispatch announce-release.yml with resume: ${V},${PRE_EN}=done; if not, resume: ${V},${PRE_EN}=101:2`,
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

  it("names a channel of only the opening as done when the answer to that opening is lost", async () => {
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
      `✗ could not read the answer of Telegram to sendMessage for ${PRE_EN}: terminated; Telegram may have taken it: if it shows in ${PRE_EN}, dispatch announce-release.yml with resume: ${finished},${PRE_EN}=done; if not, resume: ${finished}`,
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
      `✓ ${PRE_PT}: 3 posts in ${TEST_CHANNEL}`,
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
    [`${PRE_EN}=101:3`, `${PRE_EN} has 3 posts, so 3 cannot be left to post`],
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

  it.each([[["x"]], [["--root"]], [["--print", "--root"]], [["--fix"]]])(
    "a usage error exits 2 (%j)",
    async (args) => {
      const { code, err, calls } = await announceWith({ args });

      expect(code).toBe(2);
      expect(calls).toEqual([]);
      expect(err).toEqual([
        "usage: npm run release:announce -- [--print] [--root <folder>] (version in VERSION)",
      ]);
    },
  );

  it("is the release:announce npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["release:announce"]).toBe(
      "node scripts/release-announce.mjs",
    );
  });
});
