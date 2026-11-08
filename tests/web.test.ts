import { describe, it, expect, vi } from "vitest";
vi.mock("monaco-editor", () => ({ languages: {}, editor: {} }));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class {},
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}));
import { extractWeb } from "../src/importers";
describe("web snapshots", () => {
  const body =
    '<article><h1>A technical article</h1><p>Ownership is an important concept in programming. Every value has an owner, and that owner controls the lifetime of the value. This article explains the basic principles with simple examples.</p><h2>Example</h2><p>Call <code>foo.bar()</code> to read the value. Visit <a href="/guide">the guide</a> for a detailed explanation of the entire process.</p><pre>const value = "Do not translate this";</pre><script>window.evil=true</script><p onclick="alert(1)">The source remains available for reference. You can compare the original with the translation at any time.</p></article>';
  it("keeps headings, literal code and safe relative links", () => {
    const result = extractWeb(body, "https://example.org/article");
    expect(
      result.segments.some((s) => s.kind === "heading" && s.text === "Example"),
    ).toBe(true);
    expect(result.segments.find((s) => s.kind === "code")?.eligible).toBe(
      false,
    );
    expect(result.segments.map((s) => s.text).join(" ")).toContain(
      "`foo.bar()`",
    );
    expect(result.segments.map((s) => s.text).join(" ")).toContain(
      "https://example.org/guide",
    );
  });
  it("removes executable content", () => {
    const result = extractWeb(body, "https://example.org/article");
    const text = JSON.stringify(result);
    expect(text).not.toContain("window.evil");
    expect(text).not.toContain("onclick");
    expect(text).not.toContain("alert(1)");
  });
  it("does not make javascript links navigable", () => {
    const result = extractWeb(
      body.replace('href="/guide"', 'href="javascript:alert(1)"'),
      "https://example.org/article",
    );
    expect(JSON.stringify(result)).not.toContain("javascript:");
  });
});
