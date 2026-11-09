import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/api", () => ({ desktop: false, api: {} }));
import { matchesMarkdown, parseMarkdown } from "../src/markdown";
import { MarkdownPreview } from "../src/MarkdownPreview";
import type { SegmentDisplay } from "../src/SegmentView";
afterEach(cleanup);

const display = (changes: Partial<SegmentDisplay> = {}): SegmentDisplay => ({
  chosen: new Set(),
  translations: {},
  bilingual: false,
  peek: new Set(),
  selection: [],
  onPeek: vi.fn(),
  ...changes,
});
function preview(source: string, settings = display()) {
  const document = parseMarkdown(source);
  const onJump = vi.fn();
  const ui = render(
    <MarkdownPreview
      document={document}
      visible={document.pages[0]}
      display={settings}
      onJump={onJump}
      onError={vi.fn()}
    />,
  );
  return { ...ui, document, onJump };
}

describe("Markdown reading", () => {
  it("does not attach saved translations to changed sentence text or locations", () => {
    const document = parseMarkdown("Read the value.");
    expect(matchesMarkdown(document, structuredClone(document.segments))).toBe(
      true,
    );
    expect(
      matchesMarkdown(document, [
        { ...document.segments[0], text: "A different sentence." },
      ]),
    ).toBe(false);
    expect(
      matchesMarkdown(document, [
        { ...document.segments[0], location: { line: 20, endLine: 20 } },
      ]),
    ).toBe(false);
  });
  it("renders headings, nested lists, quotes, task lists and tables as document structure", () => {
    const ui = preview(
      '# Ownership\n\n### Details\n\n> Read **bold**, *emphasized* and ~~old~~ words.\n\n3. First step.\n   - Nested point.\n\n- [x] Read the guide.\n\n| Term | Meaning |\n| --- | --- |\n| Memory | A value has an owner. |\n\n```rust\nlet value = "**unchanged**";\n```\n',
    );
    expect(
      ui.getByRole("heading", { level: 1, name: "Ownership" }),
    ).toBeDefined();
    expect(
      ui.getByRole("heading", { level: 3, name: "Details" }),
    ).toBeDefined();
    expect(ui.container.querySelector("blockquote strong")?.textContent).toBe(
      "bold",
    );
    expect(ui.container.querySelector("em")?.textContent).toBe("emphasized");
    expect(ui.container.querySelector("del")?.textContent).toBe("old");
    expect(ui.container.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(ui.container.querySelector("ol li ul li")?.textContent).toContain(
      "Nested point.",
    );
    expect(ui.getByRole("checkbox", { name: "完了" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(ui.getByRole("table").querySelectorAll("th")).toHaveLength(2);
    expect(
      ui.getByRole("cell", { name: "A value has an owner." }),
    ).toBeDefined();
    expect(ui.container.querySelector("pre code")?.textContent).toBe(
      'let value = "**unchanged**";',
    );
  });

  it("splits prose sentences while retaining inline formatting, code, math and source lines", () => {
    const source =
      "# Guide\n\nRead **the value** carefully. Keep ``a`b`` unchanged. Read $x.y$ with [the guide](https://example.org/a.b).\n\n```rust\nlet value = 1;\n```\n\n$$\nx = y + z\n$$";
    const document = parseMarkdown(source);
    expect(document.segments.map((s) => s.text)).toEqual([
      "Guide",
      "Read **the value** carefully.",
      "Keep ``a`b`` unchanged.",
      "Read $x.y$ with [the guide](https://example.org/a.b).",
      "let value = 1;",
      "x = y + z",
    ]);
    expect(document.segments.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(document.segments.slice(1, 4).map((s) => s.location)).toEqual(
      Array(3).fill({ line: 3, endLine: 3, anchor: undefined }),
    );
    expect(document.segments.filter((s) => s.eligible)).toHaveLength(4);
    expect(
      document.segments
        .filter((s) => ["code", "math"].includes(s.kind))
        .every((s) => !s.eligible),
    ).toBe(true);
    expect(parseMarkdown(source).segments).toEqual(document.segments);
  });

  it("keeps inline formatting balanced across sentence boundaries and retains hard line breaks", () => {
    const document = parseMarkdown(
      "**First sentence. Second sentence.**\n\nDr.\nSmith reads.\n\nFirst line.  \nSecond line.",
    );
    expect(document.segments.slice(0, 2).map((s) => s.text)).toEqual([
      "**First sentence.**",
      "**Second sentence.**",
    ]);
    const ui = preview(
      "**First sentence. Second sentence.**\n\nDr.\nSmith reads.\n\nFirst line.  \nSecond line.",
    );
    expect(
      [...ui.container.querySelectorAll("strong")]
        .map((el) => el.textContent?.trim())
        .filter(Boolean),
    ).toEqual(["First sentence.", "Second sentence."]);
    expect(ui.container.querySelectorAll("br")).toHaveLength(1);
    expect(ui.getByText("Dr. Smith reads.")).toBeDefined();
  });

  it("translates within the preview and shows originals and translations together in bilingual mode", () => {
    const source =
      "## Guide\n\nRead **the value**. Keep `value` unchanged.\n\n| Term |\n| --- |\n| Memory |";
    const document = parseMarkdown(source);
    const sentence = document.segments[1];
    const translated = {
      segmentId: sentence.id,
      text: "**値**を読みます。",
      status: "ready" as const,
    };
    const settings = display({
      chosen: new Set([sentence.id]),
      translations: { [sentence.id]: translated },
    });
    const ui = render(
      <MarkdownPreview
        document={document}
        visible={document.pages[0]}
        display={settings}
        onJump={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(ui.container.querySelector("strong")?.textContent).toBe("値");
    expect(ui.container.textContent).not.toContain("Read the value.");
    expect(ui.getByRole("table")).toBeDefined();
    fireEvent.click(ui.getByRole("button", { name: "原文" }));
    expect(settings.onPeek).toHaveBeenCalledWith(sentence.id);
    ui.rerender(
      <MarkdownPreview
        document={document}
        visible={document.pages[0]}
        display={{ ...settings, peek: new Set([sentence.id]) }}
        onJump={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(ui.container.querySelector("strong")?.textContent).toBe("the value");
    ui.rerender(
      <MarkdownPreview
        document={document}
        visible={document.pages[0]}
        display={{ ...settings, bilingual: true }}
        onJump={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(ui.container.querySelectorAll("strong")).toHaveLength(2);
    expect(
      ui.container.querySelector(".bilingual-translation")?.textContent,
    ).toContain("値を読みます。");
  });

  it("displays hostile source and translated text without executable HTML or image requests", () => {
    const source =
      "# Safe\n\n[bad](javascript:alert(1)) ![secret](https://example.org/leak) [file](file:///private.txt)\n\n<script>window.evil = true</script>\n\n[good](https://example.org/guide)";
    const document = parseMarkdown(source);
    const id = document.segments[0].id;
    const ui = preview(
      source,
      display({
        bilingual: true,
        chosen: new Set([id]),
        translations: {
          [id]: {
            segmentId: id,
            status: "ready",
            text: '<img src=x onerror="alert(1)"> [run](javascript:alert(1))',
          },
        },
      }),
    );
    expect(
      ui.container.querySelector("script,img,iframe,svg,style"),
    ).toBeNull();
    expect(ui.container.querySelectorAll("a")).toHaveLength(1);
    expect(ui.getByRole("link", { name: "good" }).getAttribute("href")).toBe(
      "https://example.org/guide",
    );
    expect(ui.getByRole("img", { name: "secret" })).toHaveProperty(
      "tagName",
      "SPAN",
    );
  });

  it("resolves reference links and internal anchors to existing source sentences", () => {
    const ui = preview(
      "# Memory\n\n[Jump](#memory) and [Docs][guide].\n\n[guide]: https://example.org/manual",
    );
    expect(ui.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe(
      "https://example.org/manual",
    );
    fireEvent.click(ui.getByRole("link", { name: "Jump" }));
    expect(ui.onJump).toHaveBeenCalledWith(ui.document.segments[0].id);
    expect(ui.document.segments[1].text).toContain(
      "[Docs](https://example.org/manual)",
    );
  });

  it("keeps an entire table on one page rather than cutting its rows at the sentence limit", () => {
    const document = parseMarkdown(
      Array.from({ length: 79 }, (_, i) => `Paragraph ${i}.`).join("\n\n") +
        "\n\n| Term | Meaning |\n| --- | --- |\n| Memory | An owner. |",
    );
    expect(document.pages.map((page) => page.length)).toEqual([79, 4]);
    const ui = render(
      <MarkdownPreview
        document={document}
        visible={document.pages[1]}
        display={display()}
        onJump={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(ui.getByRole("table").querySelectorAll("tr")).toHaveLength(2);
    expect(ui.container.textContent).not.toContain("Paragraph 78.");
  });
});
