import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FEATURES_DOCS,
  buildFeaturesDocs,
  releaseNotes,
  run,
} from "../features-doc.mjs";
import { ENGLISH_BLOCK, PORTUGUESE_BLOCK } from "../release-notes-layout.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

function notes({ en, pt }) {
  return [
    "> [!TIP]",
    "> follow",
    "",
    ENGLISH_BLOCK,
    "",
    "### 📋 Summary",
    "",
    "- A summary line.",
    "",
    ...en,
    "",
    "</details>",
    "",
    PORTUGUESE_BLOCK,
    "",
    "### 📋 Resumo",
    "",
    "- Uma linha de resumo.",
    "",
    ...pt,
    "",
    "</details>",
  ].join("\n");
}

const BUTTONS = {
  en: [
    "### 💬 Telegram channel",
    "",
    "- ✨ **Buttons.** Questions arrive with **buttons**.",
    "",
    "  Answer with one tap.",
    "",
    "  ![Buttons](https://github.com/user-attachments/assets/gif-1)",
    "  <!-- telegram: https://github.com/user-attachments/assets/mp4-en -->",
    "",
    "- 🐛 **A fix.** Something works again.",
    "",
    "### 🔐 Security",
    "",
    "- 🔐 Pairing is stricter.",
  ],
  pt: [
    "### 💬 Canal do Telegram",
    "",
    "- ✨ **Botões.** As perguntas chegam com **botões**.",
    "",
    "  Responda com um toque.",
    "",
    "  ![Botões](https://github.com/user-attachments/assets/gif-1)",
    "  <!-- telegram: https://github.com/user-attachments/assets/mp4-pt -->",
    "",
    "### 🔐 Segurança",
    "",
    "- 🔐 O pareamento ficou mais rígido.",
  ],
};

const VOICE = {
  en: [
    "### 🎙️ Voice transcription",
    "",
    "- ✨ **Voice.** Voice messages become text.",
  ],
  pt: ["### 🎙️ Transcrição de voz", "", "- ✨ **Voz.** O áudio vira texto."],
};

const release = (file, parts) => ({ file, text: notes(parts) });

function expectNoneOf(text, hidden) {
  for (const part of hidden) {
    expect(text).not.toContain(part);
  }
}

describe("buildFeaturesDocs", () => {
  it("copies each ✨ item under its area heading, with its paragraphs, a demo link in place of the GIF and no Telegram comment", () => {
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", BUTTONS),
    ]);

    expect(docs["en-us"]).toContain(
      [
        "## 💬 Telegram channel",
        "",
        "- ✨ **Buttons.** Questions arrive with **buttons**.",
        "",
        "  Answer with one tap.",
        "",
        "  [▶ Demo](https://github.com/user-attachments/assets/gif-1)",
        "",
      ].join("\n"),
    );
    expect(docs["pt-br"]).toContain(
      [
        "## 💬 Canal do Telegram",
        "",
        "- ✨ **Botões.** As perguntas chegam com **botões**.",
        "",
        "  Responda com um toque.",
        "",
        "  [▶ Demonstração](https://github.com/user-attachments/assets/gif-1)",
      ].join("\n"),
    );
    expect(docs["en-us"]).not.toMatch(/<!--|!\[/u);
    expect(docs["pt-br"]).not.toMatch(/mp4-pt|!\[/u);
  });

  it("leaves out the summary, the fixes and the areas with no ✨ item", () => {
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", BUTTONS),
    ]);

    expect(docs["en-us"]).not.toMatch(/Summary|A fix|Security|Pairing/u);
    expect(docs["pt-br"]).not.toMatch(/Resumo|Segurança|pareamento/u);
  });

  it("opens with a title and a line on where the file comes from, in each language", () => {
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", BUTTONS),
    ]);

    expect(docs["en-us"].split("\n")[0]).toBe("# ✨ Features");
    expect(docs["pt-br"].split("\n")[0]).toBe("# ✨ Funcionalidades");
    expect(docs["en-us"]).toContain("`npm run docs:features`");
    expect(docs["pt-br"]).toContain("`npm run docs:features`");
    expect(docs["en-us"].endsWith("\n")).toBe(true);
  });

  it("keeps an item once when a later release repeats its title, with the later text in the first place", () => {
    const later = {
      en: [
        "### 💬 Telegram channel",
        "",
        "- ✨ **Buttons.** Questions arrive with **better buttons**.",
      ],
      pt: [
        "### 💬 Canal do Telegram",
        "",
        "- ✨ **Botões.** As perguntas chegam com **botões melhores**.",
      ],
    };
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", {
        en: [...BUTTONS.en, "", ...VOICE.en],
        pt: [...BUTTONS.pt, "", ...VOICE.pt],
      }),
      release("docs/releases/0.1.0/alpha.2.md", later),
    ]);

    expect(docs["en-us"].match(/\*\*Buttons\.\*\*/gu)).toHaveLength(1);
    expect(docs["en-us"]).toContain("**better buttons**");
    expect(docs["en-us"]).not.toContain("Answer with one tap.");
    expect(docs["en-us"].indexOf("Buttons.")).toBeLessThan(
      docs["en-us"].indexOf("Voice."),
    );
    expect(docs["pt-br"]).toContain("**botões melhores**");
  });

  it("moves an item to the area a later release lists it under", () => {
    const moved = {
      en: ["### 🎙️ Voice transcription", "", "- ✨ **Buttons.** Now here."],
      pt: ["### 🎙️ Transcrição de voz", "", "- ✨ **Botões.** Agora aqui."],
    };
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", BUTTONS),
      release("docs/releases/0.1.0/alpha.2.md", moved),
    ]);

    expect(docs["en-us"]).not.toContain("## 💬 Telegram channel");
    expect(docs["en-us"]).toContain(
      "## 🎙️ Voice transcription\n\n- ✨ **Buttons.** Now here.",
    );
  });

  it("drops an item that a later release removes with 🔥, and the area left empty", () => {
    const removed = {
      en: ["### 💬 Telegram channel", "", "- 🔥 **Buttons.** They are gone."],
      pt: ["### 💬 Canal do Telegram", "", "- 🔥 **Botões.** Eles saíram."],
    };
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", {
        en: [...BUTTONS.en, "", ...VOICE.en],
        pt: [...BUTTONS.pt, "", ...VOICE.pt],
      }),
      release("docs/releases/0.1.0/alpha.2.md", removed),
    ]);

    expect(docs["en-us"]).not.toMatch(/Buttons|Telegram channel|gone/u);
    expect(docs["pt-br"]).not.toMatch(/Botões|saíram/u);
    expect(docs["en-us"]).toContain("**Voice.**");
  });

  it("stops at a line that is neither indented nor blank, so the next bullet is not part of the item", () => {
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", {
        en: [
          "### 💬 Telegram channel",
          "",
          "- ✨ **Buttons.** One.",
          "- ✨ **Voice.** Two.",
        ],
        pt: [
          "### 💬 Canal do Telegram",
          "",
          "- ✨ **Botões.** Um.",
          "- ✨ **Voz.** Dois.",
        ],
      }),
    ]);

    expect(docs["en-us"]).toContain(
      "- ✨ **Buttons.** One.\n\n- ✨ **Voice.** Two.\n",
    );
  });

  it("drops an HTML comment that spans several lines, keeping the lines after it", () => {
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", {
        en: [
          "### 💬 Telegram channel",
          "",
          "- ✨ **Buttons.** One.",
          "",
          "  <!--",
          "  telegram: https://github.com/user-attachments/assets/mp4-en",
          "  -->",
          "",
          "  After the comment.",
        ],
        pt: [
          "### 💬 Canal do Telegram",
          "",
          "- ✨ **Botões.** Um.",
          "  <!-- telegram:",
          "  https://github.com/user-attachments/assets/mp4-pt -->",
          "  Depois do comentário.",
        ],
      }),
    ]);

    expect(docs["en-us"]).toContain(
      "- ✨ **Buttons.** One.\n\n\n  After the comment.\n",
    );
    expect(docs["pt-br"]).toContain(
      "- ✨ **Botões.** Um.\n  Depois do comentário.\n",
    );
    expectNoneOf(docs["en-us"], ["<!--", "-->", "mp4-en", "telegram:"]);
    expectNoneOf(docs["pt-br"], ["<!--", "-->", "mp4-pt", "telegram:"]);
  });

  it("keeps the text after a comment that closes on a line", () => {
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", {
        en: [
          "### 💬 Telegram channel",
          "",
          "- ✨ **Buttons.** One.",
          "  <!-- metadata",
          "  --> Visible text.",
          "  More details.",
        ],
        pt: ["### 💬 Canal do Telegram", "", "- ✨ **Botões.** Um."],
      }),
    ]);

    expect(docs["en-us"]).toContain(
      "- ✨ **Buttons.** One.\n  Visible text.\n  More details.\n",
    );
    expectNoneOf(docs["en-us"], ["<!--", "-->", "metadata"]);
  });

  it("keeps the text after a comment that opens and closes on the same line", () => {
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", {
        en: [
          "### 💬 Telegram channel",
          "",
          "- ✨ **Buttons.** One.",
          "  <!-- telegram: https://github.com/user-attachments/assets/mp4-en --> Visible.",
          "  <!-- a --> <!-- b --> Seen.",
          "  <!---> Short.",
          "  <!--> Empty.",
          "  <!-- c --> <!-- d",
          "  hidden -->",
          "  <!-- e --> Between <!-- f -->",
          "  <!-- g --> Before <!-- h",
          "  secret -->",
          "  Next line.",
        ],
        pt: ["### 💬 Canal do Telegram", "", "- ✨ **Botões.** Um."],
      }),
    ]);

    expect(docs["en-us"]).toContain(
      "- ✨ **Buttons.** One.\n  Visible.\n  Seen.\n  Short.\n  Empty.\n  Between\n  Before\n  Next line.\n",
    );
    expectNoneOf(docs["en-us"], [
      "<!--",
      "-->",
      "telegram:",
      "hidden",
      "secret",
    ]);
  });

  it("keeps a line that only mentions a comment inside its text", () => {
    const docs = buildFeaturesDocs([
      release("docs/releases/0.1.0/alpha.1.md", {
        en: [
          "### 💬 Telegram channel",
          "",
          "- ✨ **Buttons.** One.",
          "  Write `<!-- notes -->` around the notes.",
        ],
        pt: ["### 💬 Canal do Telegram", "", "- ✨ **Botões.** Um."],
      }),
    ]);

    expect(docs["en-us"]).toContain(
      "  Write `<!-- notes -->` around the notes.",
    );
  });

  it("refuses notes without the Portuguese block", () => {
    expect(() =>
      buildFeaturesDocs([
        { file: "docs/releases/0.1.0/alpha.1.md", text: "no blocks" },
      ]),
    ).toThrow(
      `docs/releases/0.1.0/alpha.1.md has no ${PORTUGUESE_BLOCK} block`,
    );
  });
});

describe("releaseNotes", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "features-doc-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(path, text = "x") {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  it("reads every notes file in the order of their versions, the stable after its pre-releases", () => {
    write("docs/releases/0.2.0/stable.md");
    write("docs/releases/0.2.0/alpha.10.md");
    write("docs/releases/0.1.0/stable.md");
    write("docs/releases/0.2.0/alpha.2.md");
    write("docs/releases/0.2.0/rc.1.md");
    write("docs/releases/0.10.0/beta.1.md");

    expect(releaseNotes(root).map(({ file }) => file)).toEqual([
      "docs/releases/0.1.0/stable.md",
      "docs/releases/0.2.0/alpha.2.md",
      "docs/releases/0.2.0/alpha.10.md",
      "docs/releases/0.2.0/rc.1.md",
      "docs/releases/0.2.0/stable.md",
      "docs/releases/0.10.0/beta.1.md",
    ]);
  });

  it("ignores a file that is not the notes of a version", () => {
    write("docs/releases/0.1.0/notes.txt");
    write("docs/releases/README.md");

    expect(releaseNotes(root)).toEqual([]);
  });

  it("reads nothing when there is no docs/releases yet", () => {
    expect(releaseNotes(root)).toEqual([]);
  });
});

describe("run", () => {
  let root;
  const out = [];
  const err = [];
  const io = () => ({
    root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "features-doc-"));
    out.length = 0;
    err.length = 0;
    mkdirSync(join(root, "docs/releases/0.1.0"), { recursive: true });
    writeFileSync(join(root, "docs/releases/0.1.0/alpha.1.md"), notes(BUTTONS));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the two feature docs from the release notes", () => {
    expect(run([], io())).toBe(0);

    const written = Object.values(FEATURES_DOCS).map((path) =>
      readFileSync(join(root, path), "utf8"),
    );

    expect(written[0]).toContain("**Buttons.**");
    expect(written[1]).toContain("**Botões.**");
    expect(out).toEqual([
      `✓ ${FEATURES_DOCS["en-us"]} and ${FEATURES_DOCS["pt-br"]} written from 1 release notes file`,
    ]);
  });

  it("passes --check when the docs match the notes", () => {
    run([], io());
    out.length = 0;

    expect(run(["--check"], io())).toBe(0);
    expect(out).toEqual(["✓ the feature docs match the release notes"]);
  });

  it("fails --check naming each doc that is missing or out of date, with the command that fixes it", () => {
    run([], io());
    writeFileSync(join(root, FEATURES_DOCS["en-us"]), "stale\n");
    rmSync(join(root, FEATURES_DOCS["pt-br"]));

    expect(run(["--check"], io())).toBe(1);
    expect(err).toEqual([
      `✗ ${FEATURES_DOCS["en-us"]} is out of date with docs/releases: run npm run docs:features`,
      `✗ ${FEATURES_DOCS["pt-br"]} is out of date with docs/releases: run npm run docs:features`,
    ]);
  });

  it("refuses any other argument", () => {
    expect(run(["--write"], io())).toBe(2);
    expect(err).toEqual(["usage: npm run docs:features -- [--check]"]);
  });

  it("is the docs:features npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["docs:features"]).toBe("node scripts/features-doc.mjs");
  });
});

describe("the feature docs of the repository", () => {
  it("match what the release notes in docs/releases build", () => {
    const built = buildFeaturesDocs(releaseNotes(ROOT));

    for (const [language, path] of Object.entries(FEATURES_DOCS)) {
      expect(readFileSync(join(ROOT, path), "utf8")).toBe(built[language]);
    }
  });
});
