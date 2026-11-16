import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CHANNEL_GUIDE_SKILL } from "../instructions.ts";

const PLUGIN_ROOT = join(import.meta.dirname, "..", "..");
const [PLUGIN_NAME, SKILL_NAME] = CHANNEL_GUIDE_SKILL.split(":");
const SKILL_DIR = join(PLUGIN_ROOT, "skills", SKILL_NAME);
const REFERENCE_DIR = join(SKILL_DIR, "reference");
const SKILL_TEXT = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/.exec(SKILL_TEXT)?.[1] ?? "";

function reference(name: string): string {
  return readFileSync(join(REFERENCE_DIR, name), "utf8");
}

describe("channel guide skill › layout", () => {
  it("lives in the telegram plugin, under the name the instructions load", (): void => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
    );

    expect(manifest).toMatchObject({ name: PLUGIN_NAME });
    expect(FRONTMATTER).toContain(`name: ${SKILL_NAME}\n`);
  });

  it("is loaded by Claude only, out of the slash menu, with a description that names what it covers", (): void => {
    expect(FRONTMATTER).toContain("user-invocable: false");
    expect(FRONTMATTER).not.toContain("disable-model-invocation");
    expect(FRONTMATTER).toMatch(
      /\ndescription: .*table.*image.*video.*(diagram|drawing)/u,
    );
  });

  it("links every reference file once, and every link points to a file that exists", (): void => {
    const linked = [...SKILL_TEXT.matchAll(/\]\(reference\/([\w-]+\.md)\)/gu)]
      .map(([, file]) => file)
      .toSorted();

    expect(linked).toEqual(readdirSync(REFERENCE_DIR).toSorted());
    expect(new Set(linked).size).toBe(linked.length);
  });

  it("renders mermaid with the plugin script through the plugin root of the SKILL.md body", (): void => {
    const command =
      /`bun "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)" <file\.mmd>`/u.exec(SKILL_TEXT);

    expect(command?.[1]).toBe("extensions/mermaid-png.ts");
    expect(existsSync(join(PLUGIN_ROOT, command?.[1] ?? "missing"))).toBe(true);
    expect(
      readdirSync(REFERENCE_DIR).filter((name) =>
        reference(name).includes("CLAUDE_PLUGIN_ROOT"),
      ),
    ).toEqual([]);
  });
});

describe("channel guide skill › page capture", () => {
  it("runs the page capture with the plugin script through the plugin root of the SKILL.md body", (): void => {
    const command =
      /`bun "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)" <spec\.json>`/u.exec(
        SKILL_TEXT,
      );

    expect(command?.[1]).toBe("extensions/page-capture.ts");
    expect(existsSync(join(PLUGIN_ROOT, command?.[1] ?? "missing"))).toBe(true);
    expect(reference("illustrations.md")).toContain(
      "The page capture named in SKILL.md",
    );
  });

  it("shows a visual idea before building it, today next to each proposal, outlined in red in the page", (): void => {
    const text = reference("illustrations.md");

    expect(text).toContain(
      "Every visual idea goes to the user before it is built",
    );
    expect(text).toContain("#e11d48, 4 px, drawn in the page");
    expect(text).toContain("a 2x close-up when the element is small");
    expect(text).toContain(
      "With illustrations off, describe the idea in words",
    );
    expect(text).toContain("A secret never goes on a screenshot");
  });
});

describe("channel guide skill › conversation and secretary", () => {
  it("asks with an example on every option and the research behind the decision", (): void => {
    const text = reference("conversation.md");

    expect(text).toContain(
      "Every option carries a concrete example of its result",
    );
    expect(text).toContain(
      "the path you took, what you measured and why each discarded option left",
    );
    expect(text).toContain("never by the number alone");
  });

  it("relays and routes for the other sessions without editing the repository or the background workers", (): void => {
    const text = reference("secretary.md");

    expect(text).toContain("that session is the secretary");
    expect(text).toContain("It does not edit the repository");
    expect(text).toContain("It does not relay to background workers");
  });
});

describe("channel guide skill › references", () => {
  it("sends tables as aligned columns in a markdownv2 code block, escaping outside it", (): void => {
    const text = reference("tables.md");

    expect(text).toContain("Telegram does not render markdown tables");
    expect(text).toContain('format: "markdownv2"');
    expect(text).toContain("only ` and \\ inside them");
  });

  it("checks every image and video, keeps the cited order and zips what needs the exact bytes", (): void => {
    const text = reference("images.md");

    expect(text).toContain(
      "Open and check every image before sending it, and the frame sheet of every video, since a video cannot be played here",
    );
    expect(text).toContain("in the order the text cites them");
    expect(text).toContain("recompressed");
    expect(text).toContain(".zip");
  });

  it("draws a flow as a mermaid file in the scratchpad and sends the PNG through reply", (): void => {
    const text = reference("mermaid.md");

    expect(text).toContain("mermaid file in the scratchpad");
    expect(text).toContain("reply(files: [path])");
  });
});
