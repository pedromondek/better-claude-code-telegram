import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { compareVersions } from "./release-order.mjs";
import { ENGLISH_BLOCK, PORTUGUESE_BLOCK } from "./release-notes-layout.mjs";
import { isVersion } from "./version.mjs";

export const FEATURES_DOCS = {
  "en-us": "docs/features/features.md",
  "pt-br": "docs/features/features.pt-br.md",
};

const RELEASES_FOLDER = "docs/releases";
const COMMAND = "npm run docs:features";
const USAGE = `usage: ${COMMAND} -- [--check]`;
const NOTES_FILE = /^(alpha|beta|rc)\.(\d+)\.md$|^stable\.md$/u;
const AREA_HEADING = "### ";
const ITEM = /^- (✨|🔥) \*\*(.+?)\*\*/u;
const NEW = "✨";
const ITEM_BODY_LINE = /^(?:\s+\S|\s*$)/u;
const COMMENT_START = "<!--";
const COMMENT_END = "-->";
const IMAGE_LINE = /^(\s*)!\[[^\]]*\]\((\S+)\)\s*$/u;
const DEMO_LABEL = { "en-us": "▶ Demo", "pt-br": "▶ Demonstração" };
const HEADER = {
  "en-us": [
    "# ✨ Features",
    "",
    `Every feature the releases shipped, as their notes describe it. The release writes this file from \`${RELEASES_FOLDER}\` with \`${COMMAND}\`; the [versioning](../versioning/versioning.md) doc has the flow.`,
  ],
  "pt-br": [
    "# ✨ Funcionalidades",
    "",
    `Toda funcionalidade que as versões lançaram, como as notas a descrevem. O release escreve este arquivo a partir de \`${RELEASES_FOLDER}\` com \`${COMMAND}\`; a doc de [versionamento](../versioning/versioning.pt-br.md) traz o fluxo.`,
  ],
};

function versionOf(folder, name) {
  const match = NOTES_FILE.exec(name);

  return match[1] === undefined ? folder : `${folder}-${match[1]}.${match[2]}`;
}

export function releaseNotes(root) {
  const base = join(root, RELEASES_FOLDER);

  if (!existsSync(base)) {
    return [];
  }

  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isVersion(entry.name))
    .flatMap(({ name: folder }) =>
      readdirSync(join(base, folder))
        .filter((name) => NOTES_FILE.test(name))
        .map((name) => ({
          version: versionOf(folder, name),
          file: `${RELEASES_FOLDER}/${folder}/${name}`,
        })),
    )
    .toSorted((left, right) => compareVersions(left.version, right.version))
    .map(({ file }) => ({
      file,
      text: readFileSync(join(root, file), "utf8"),
    }));
}

function languageParts(text, file) {
  const notes = text.replaceAll("\r\n", "\n");
  const start = notes.indexOf(PORTUGUESE_BLOCK);

  if (start === -1) {
    throw new Error(`${file} has no ${PORTUGUESE_BLOCK} block`);
  }

  const englishStart = notes.indexOf(ENGLISH_BLOCK);

  return {
    "en-us": notes.slice(englishStart === -1 ? 0 : englishStart, start),
    "pt-br": notes.slice(start + PORTUGUESE_BLOCK.length),
  };
}

function demoLink(line, language) {
  const image = IMAGE_LINE.exec(line);

  return image === null
    ? line
    : `${image[1]}[${DEMO_LABEL[language]}](${image[2]})`;
}

function withoutComments(lines) {
  let inComment = false;

  return lines.flatMap((line) => {
    let rest = line.trim();

    if (!inComment && !rest.startsWith(COMMENT_START)) {
      return [line];
    }

    let visible = "";

    while (rest !== "") {
      const open = inComment ? 0 : rest.indexOf(COMMENT_START);

      if (open === -1) {
        visible += rest;
        rest = "";
      } else {
        visible += rest.slice(0, open);

        const close = rest.indexOf(COMMENT_END, open);

        inComment = close === -1;
        rest = inComment ? "" : rest.slice(close + COMMENT_END.length);
      }
    }

    const text = visible.trim();

    return text === ""
      ? []
      : [`${line.slice(0, line.length - line.trimStart().length)}${text}`];
  });
}

function itemLines(lines, language) {
  const end = lines.findIndex((line) => !ITEM_BODY_LINE.test(line));
  const body = withoutComments(
    lines.slice(0, end === -1 ? lines.length : end),
  ).map((line) => demoLink(line, language));

  while (body.length > 0 && body.at(-1).trim() === "") {
    body.pop();
  }

  return body;
}

function itemsOf(part, language) {
  const lines = part.split("\n");
  let area = null;

  return lines.flatMap((line, index) => {
    if (line.startsWith(AREA_HEADING)) {
      area = line.slice(AREA_HEADING.length).trim();
      return [];
    }

    const match = ITEM.exec(line);

    return match === null
      ? []
      : [
          {
            area,
            kind: match[1],
            title: match[2],
            lines: [line, ...itemLines(lines.slice(index + 1), language)],
          },
        ];
  });
}

function collect(items, features) {
  for (const item of items) {
    const known = features.get(item.title);

    if (item.kind !== NEW) {
      features.delete(item.title);
    } else if (known !== undefined && known.area === item.area) {
      features.set(item.title, item);
    } else {
      features.delete(item.title);
      features.set(item.title, item);
    }
  }
}

function render(language, features) {
  const areas = new Map();

  for (const { area, lines } of features.values()) {
    areas.set(area, [...(areas.get(area) ?? []), lines.join("\n")]);
  }

  return [
    ...HEADER[language],
    ...[...areas].flatMap(([area, items]) => [
      "",
      `## ${area}`,
      "",
      items.join("\n\n"),
    ]),
    "",
  ].join("\n");
}

export function buildFeaturesDocs(notes) {
  const features = { "en-us": new Map(), "pt-br": new Map() };

  for (const { file, text } of notes) {
    const parts = languageParts(text, file);

    for (const language of Object.keys(features)) {
      collect(itemsOf(parts[language], language), features[language]);
    }
  }

  return Object.fromEntries(
    Object.entries(features).map(([language, items]) => [
      language,
      render(language, items),
    ]),
  );
}

export function featuresFiles(root) {
  const docs = buildFeaturesDocs(releaseNotes(root));

  return Object.entries(FEATURES_DOCS).map(([language, path]) => ({
    path,
    text: docs[language],
  }));
}

export function run(args, { root, out, err }) {
  const check = args.length === 1 && args[0] === "--check";

  if (args.length > 0 && !check) {
    err(USAGE);
    return 2;
  }

  const files = featuresFiles(root);

  if (check) {
    const stale = files.filter(
      ({ path, text }) =>
        !existsSync(join(root, path)) ||
        readFileSync(join(root, path), "utf8") !== text,
    );

    for (const { path } of stale) {
      err(`✗ ${path} is out of date with ${RELEASES_FOLDER}: run ${COMMAND}`);
    }

    if (stale.length === 0) {
      out("✓ the feature docs match the release notes");
    }

    return stale.length === 0 ? 0 : 1;
  }

  for (const { path, text } of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  const count = releaseNotes(root).length;

  out(
    `✓ ${FEATURES_DOCS["en-us"]} and ${FEATURES_DOCS["pt-br"]} written from ${count} release notes ${count === 1 ? "file" : "files"}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    root: process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
