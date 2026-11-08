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
    let previous = new Set<string>();
    for (let ratio = 0; ratio <= 100; ratio++) {
      const next = chosenSegments(segments, ratio);
      expect(next.size).toBe(ratio);
      for (const id of previous) expect(next.has(id)).toBe(true);
      previous = next;
    }
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
  it.each([
    [25, "日英英英"],
    [50, "日英日英"],
    [75, "日日日英"],
  ])("distributes Japanese and English at %i percent", (ratio, pattern) => {
    const chosen = chosenSegments(segments, ratio);
    expect(segments.map((s) => (chosen.has(s.id) ? "日" : "英")).join("")).toBe(
      pattern.repeat(25),
    );
  });
  it("alternates an odd number of eligible sentences without counting code or Japanese", () => {
    const mixed = orderSegments([
      ...makeSegments("The first sentence.", 0),
      ...makeSegments("日本語です。", 1),
      ...makeSegments('let value = "hello";', 2, "code"),
      ...makeSegments(
        "The second sentence. The third sentence. The fourth sentence. The fifth sentence.",
        3,
      ),
    ]);
    const chosen = chosenSegments(mixed, 50);
    expect([...chosen].sort()).toEqual(["b0s0", "b3s1", "b3s3"]);
  });
  it("uses document order independently of IDs and leaves the source unchanged", () => {
    const renamed = segments.map((s, i) => ({
      ...s,
      id: `sentence-${100 - i}`,
    }));
    const original = structuredClone(renamed);
    const chosen = chosenSegments([...renamed].reverse(), 50);
    expect(renamed.slice(0, 8).map((s) => chosen.has(s.id))).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(renamed).toEqual(original);
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
