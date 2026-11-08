import { describe, it, expect } from "vitest";
import {
  chosenSegments,
  makeSegments,
  orderSegments,
  sentences,
  selectReferences,
  referenceIds,
  isEnglish,
  extractText,
} from "../src/core";
import { previewDocument, previewTranslations } from "../src/preview";
describe("translation selection", () => {
  const segments = orderSegments(
    Array.from({ length: 100 }, (_, i) =>
      makeSegments(`Sentence number ${i} is readable.`, i),
    ).flat(),
  );
  it("selects exactly zero, half and all eligible sentences", () => {
    expect(chosenSegments(segments, 0).size).toBe(0);
    expect(chosenSegments(segments, 50).size).toBe(50);
    expect(chosenSegments(segments, 100).size).toBe(100);
  });
  it("is monotonic and stable across slider round trips", () => {
    const half = chosenSegments(segments, 50);
    const more = chosenSegments(segments, 60);
    for (const id of half) expect(more.has(id)).toBe(true);
    expect(chosenSegments(segments, 50)).toEqual(half);
    expect(chosenSegments([...segments].reverse(), 50)).toEqual(half);
  });
  it("excludes code and math from denominator", () => {
    const protectedSegments = [
      ...segments,
      ...makeSegments('const value = "Hello world";', 101, "code"),
      ...makeSegments("x = y + z", 102, "math"),
    ];
    expect(chosenSegments(protectedSegments, 100).size).toBe(100);
  });
  it("spreads translation over the document", () => {
    const chosen = chosenSegments(segments, 50);
    for (let start = 0; start < 100; start += 25)
      expect(
        segments.slice(start, start + 25).some((s) => chosen.has(s.id)),
      ).toBe(true);
  });
});
describe("source fidelity", () => {
  it("retains inline literals while splitting sentences", () => {
    expect(sentences("Call `foo.bar()`. Then use $x.y$.")).toEqual([
      "Call `foo.bar()`.",
      "Then use $x.y$.",
    ]);
  });
  it("handles English abbreviations", () => {
    expect(sentences("Dr. Smith reads the book.")).toEqual([
      "Dr. Smith reads the book.",
    ]);
  });
  it("protects fenced code and display equations in Markdown", () => {
    const segments = extractText(
      '# Introduction\n\nRead the value.\n\n```rs\nlet message = "hello world";\n```\n\n$$\nx = the_value\n$$',
    );
    expect(segments.filter((s) => s.eligible).length).toBe(2);
    expect(segments.find((s) => s.kind === "code")?.text).toBe(
      'let message = "hello world";',
    );
    expect(segments.find((s) => s.kind === "math")?.eligible).toBe(false);
  });
  it("does not translate Japanese prose or literals", () => {
    expect(isEnglish("これは日本語です。")).toBe(false);
    expect(isEnglish("`hello world`")).toBe(false);
    expect(isEnglish("Memory has an owner.")).toBe(true);
  });
  it("pairs translated selection with immutable original", () => {
    const s = previewDocument.segments.find((s) => s.eligible)!;
    const refs = selectReferences(previewDocument, [s.id], { [s.id]: "訳文" });
    expect(refs[0].text).toBe(s.text);
    expect(refs[0].translation).toBe("訳文");
    expect(refs[0].revision).toBe(previewDocument.revision);
  });
  it("never resolves invented references", () => {
    const s = previewDocument.segments[0];
    const refs = selectReferences(previewDocument, [s.id]);
    expect(referenceIds(`[ref:${s.id}] [ref:invented]`, refs)).toEqual([s.id]);
  });
  it("sample translations retain one-to-one alignment", () => {
    expect(
      previewTranslations[
        previewDocument.segments.find(
          (s) => s.text === "Every value in Rust has an owner.",
        )!.id
      ].text,
    ).toBe("Rustのすべての値には所有者がいる。");
  });
});
