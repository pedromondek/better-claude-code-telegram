import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isRecord } from "./config.ts";

export type Step =
  { click: string } | { hover: string } | { wait: number } | { script: string };

export interface Shot {
  name: string;
  url: string;
  css: string | null;
  steps: Step[];
  outline: string[];
  clip: string | null;
  fullPage: boolean;
}

export interface VideoShot extends Shot {
  seconds: number;
  fps: number;
}

export interface BoardCard {
  shot: string;
  label: string;
  caption: string | null;
}

export interface BoardSection {
  heading: string;
  effect: string | null;
  cards: BoardCard[];
}

export interface Board {
  name: string;
  title: string;
  context: string | null;
  sections: BoardSection[];
}

export interface CaptureSpec {
  url: string;
  out: string;
  width: number;
  height: number;
  scale: number;
  shots: Shot[];
  videos: VideoShot[];
  board: Board | null;
}

export class SpecError extends Error {}

type Fields = Record<string, unknown>;

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_SCALE = 2;
const DEFAULT_FPS = 12;
const MAX_VIDEO_SECONDS = 30;
const MAX_FPS = 30;
const NAME_PATTERN = /^[\w-]+$/;
const GENERATED_SUFFIX = /^-(?:\d+|sheet(?:-\d+)?)$/;
const URL_SCHEME = /^[a-z][a-z\d+.-]+:/i;
const STEP_KINDS = ["click", "hover", "wait", "script"] as const;

function fail(message: string): never {
  throw new SpecError(message);
}

function fieldsAt(value: unknown, path: string): Fields {
  return isRecord(value) ? value : fail(`${path} must be an object`);
}

function textAt(value: unknown, path: string): string {
  return typeof value === "string" && value !== ""
    ? value
    : fail(`${path} must be a text`);
}

function optionalTextAt(value: unknown, path: string): string | null {
  return value === undefined ? null : textAt(value, path);
}

function positiveNumberAt(value: unknown, path: string): number {
  return typeof value === "number" && value > 0 && value < Infinity
    ? value
    : fail(`${path} must be a positive number`);
}

function numberAt(value: unknown, path: string, fallback: number): number {
  return value === undefined ? fallback : positiveNumberAt(value, path);
}

function atMost(value: number, limit: number, path: string): number {
  return value <= limit ? value : fail(`${path} must be at most ${limit}`);
}

function listAt(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];

  return Array.isArray(value) ? value : fail(`${path} must be a list`);
}

function urlFrom(raw: string, specDir: string): string {
  return URL_SCHEME.test(raw) ? raw : pathToFileURL(resolve(specDir, raw)).href;
}

function stepAt(value: unknown, path: string): Step {
  const fields = fieldsAt(value, path);
  const kind =
    STEP_KINDS.find((candidate) => fields[candidate] !== undefined) ??
    fail(`${path} must have one of click, hover, wait or script`);

  if (kind === "wait") {
    return { wait: positiveNumberAt(fields.wait, `${path}.wait`) };
  }

  const text = textAt(fields[kind], `${path}.${kind}`);

  return kind === "click"
    ? { click: text }
    : kind === "hover"
      ? { hover: text }
      : { script: text };
}

function outlineAt(value: unknown, path: string): string[] {
  const selectors = typeof value === "string" ? [value] : (value ?? []);
  const message = `${path} must be a text or a list of texts`;

  if (!Array.isArray(selectors)) return fail(message);

  return selectors.map((selector) =>
    typeof selector === "string" && selector !== "" ? selector : fail(message),
  );
}

function booleanAt(value: unknown, path: string): boolean {
  if (value === undefined) return false;

  return typeof value === "boolean"
    ? value
    : fail(`${path} must be true or false`);
}

function generates(name: string, other: string): boolean {
  return (
    name.startsWith(other) && GENERATED_SUFFIX.test(name.slice(other.length))
  );
}

class NameRegistry {
  private readonly used = new Set<string>();

  take(value: unknown, path: string): string {
    const name = textAt(value, path);

    if (!NAME_PATTERN.test(name)) {
      fail(`${path} must use only letters, digits, - and _`);
    }

    if (this.used.has(name)) fail(`${path} repeats ${name}`);

    const clash = [...this.used].find(
      (used) => generates(name, used) || generates(used, name),
    );

    if (clash !== undefined) fail(`${path} repeats the files of ${clash}`);

    this.used.add(name);

    return name;
  }
}

function shotAt(
  value: unknown,
  path: string,
  pageUrl: string,
  specDir: string,
  names: NameRegistry,
): Shot {
  const fields = fieldsAt(value, path);
  const name = names.take(fields.name, `${path}.name`);
  const url = optionalTextAt(fields.url, `${path}.url`);

  return {
    name,
    url: url === null ? pageUrl : urlFrom(url, specDir),
    css: optionalTextAt(fields.css, `${path}.css`),
    steps: listAt(fields.steps, `${path}.steps`).map((step, index) =>
      stepAt(step, `${path}.steps[${index}]`),
    ),
    outline: outlineAt(fields.outline, `${path}.outline`),
    clip: optionalTextAt(fields.clip, `${path}.clip`),
    fullPage: booleanAt(fields.fullPage, `${path}.fullPage`),
  };
}

function videoAt(
  value: unknown,
  path: string,
  pageUrl: string,
  specDir: string,
  names: NameRegistry,
): VideoShot {
  const shot = shotAt(value, path, pageUrl, specDir, names);
  const fields = fieldsAt(value, path);
  const seconds = positiveNumberAt(fields.seconds, `${path}.seconds`);
  const fps = numberAt(fields.fps, `${path}.fps`, DEFAULT_FPS);

  return {
    ...shot,
    seconds: atMost(seconds, MAX_VIDEO_SECONDS, `${path}.seconds`),
    fps: atMost(fps, MAX_FPS, `${path}.fps`),
  };
}

function cardAt(value: unknown, path: string, shots: Set<string>): BoardCard {
  const fields = fieldsAt(value, path);
  const shot = textAt(fields.shot, `${path}.shot`);

  if (!shots.has(shot)) fail(`${path}.shot names no shot: ${shot}`);

  return {
    shot,
    label: textAt(fields.label, `${path}.label`),
    caption: optionalTextAt(fields.caption, `${path}.caption`),
  };
}

function boardAt(
  value: unknown,
  shots: Set<string>,
  names: NameRegistry,
): Board | null {
  if (value === undefined) return null;

  const fields = fieldsAt(value, "board");
  const name = names.take(fields.name, "board.name");
  const sections = listAt(fields.sections, "board.sections");

  if (sections.length === 0) {
    fail("board.sections must have at least one section");
  }

  return {
    name,
    title: textAt(fields.title, "board.title"),
    context: optionalTextAt(fields.context, "board.context"),
    sections: sections.map((section, index) => {
      const path = `board.sections[${index}]`;
      const sectionFields = fieldsAt(section, path);

      return {
        heading: textAt(sectionFields.heading, `${path}.heading`),
        effect: optionalTextAt(sectionFields.effect, `${path}.effect`),
        cards: listAt(sectionFields.cards, `${path}.cards`).map(
          (card, cardIndex) =>
            cardAt(card, `${path}.cards[${cardIndex}]`, shots),
        ),
      };
    }),
  };
}

export function parseCaptureSpec(text: string, specPath: string): CaptureSpec {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail((error as SyntaxError).message);
  }

  const fields = fieldsAt(parsed, "the spec");
  const specDir = dirname(specPath);
  const url = urlFrom(textAt(fields.url, "url"), specDir);
  const out = fields.out === undefined ? specDir : textAt(fields.out, "out");
  const names = new NameRegistry();
  const width = numberAt(fields.width, "width", DEFAULT_WIDTH);
  const height = numberAt(fields.height, "height", DEFAULT_HEIGHT);
  const scale = numberAt(fields.scale, "scale", DEFAULT_SCALE);
  const shots = listAt(fields.shots, "shots").map((shot, index) =>
    shotAt(shot, `shots[${index}]`, url, specDir, names),
  );
  const videos = listAt(fields.videos, "videos").map((video, index) =>
    videoAt(video, `videos[${index}]`, url, specDir, names),
  );

  return {
    url,
    out: resolve(specDir, out),
    width,
    height,
    scale,
    shots,
    videos,
    board: boardAt(
      fields.board,
      new Set(shots.map((shot) => shot.name)),
      names,
    ),
  };
}
