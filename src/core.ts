import type { Document, Segment, Reference } from "./types";

export function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function chosenSegments(
  segments: Segment[],
  ratio: number,
): Set<string> {
  const items = segments
    .filter((s) => s.eligible)
    .sort((a, b) => hash(a.id) - hash(b.id) || a.id.localeCompare(b.id));
  const count = Math.round(
    (items.length * Math.min(100, Math.max(0, ratio))) / 100,
  );
  return new Set(items.slice(0, count).map((s) => s.id));
}
export function isEnglish(text: string): boolean {
  const plain = text.replace(/`[^`]*`|\$[^$]*\$|https?:\/\/\S+/g, "");
  return (
    /\b[A-Za-z]{2,}\b/.test(plain) &&
    !/[\u3040-\u30ff\u3400-\u9fff]/.test(plain)
  );
}
export function sentences(text: string): string[] {
  // Protect inline literals and math from sentence boundaries, retaining exact source spelling.
  const protectedText: string[] = [];
  const safe = text.replace(/`[^`\n]*`|\$[^$\n]+\$/g, (m) => {
    protectedText.push(m);
    return `\uE000${protectedText.length - 1}\uE001`;
  });
  const parts = [
    ...new Intl.Segmenter("en", { granularity: "sentence" }).segment(safe),
  ]
    .map((x) => x.segment.trim())
    .filter(Boolean);
  const joined: string[] = [];
  for (const part of parts) {
    if (
      joined.length &&
      /\b(?:Mr|Mrs|Ms|Dr|Prof|vs|e\.g|i\.e)\.$/i.test(joined[joined.length - 1])
    )
      joined[joined.length - 1] += " " + part;
    else joined.push(part);
  }
  return joined.map((s) =>
    s.replace(/\uE000(\d+)\uE001/g, (_, n) => protectedText[Number(n)]),
  );
}
export function extractText(text: string): Segment[] {
  const lines = text.split("\n");
  const out: Segment[] = [];
  let block = 0;
  let buffer: string[] = [];
  let start = 1;
  let fence: string | null = null;
  let fencedKind: Segment["kind"] = "code";
  const flush = (kind: Segment["kind"] = "paragraph") => {
    if (buffer.length) {
      out.push(
        ...makeSegments(buffer.join("\n"), block++, kind, {
          line: start,
          endLine: start + buffer.length - 1,
        }),
      );
      buffer = [];
    }
  };
  lines.forEach((line, i) => {
    if (fence) {
      if (line.trim().startsWith(fence)) {
        flush(fencedKind);
        fence = null;
      } else buffer.push(line);
      return;
    }
    const marker = /^\s*(`{3,}|~{3,}|\$\$)\s*\w*\s*$/.exec(line);
    if (marker) {
      flush();
      fence = marker[1];
      fencedKind = fence === "$$" ? "math" : "code";
      start = i + 2;
      return;
    }
    if (!line.trim()) {
      flush();
      return;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      start = i + 1;
      buffer = [heading[1]];
      flush("heading");
      return;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flush();
      start = i + 1;
      buffer = [line.replace(/^\s*[-*+]\s+/, "")];
      flush("list");
      return;
    }
    if (!buffer.length) start = i + 1;
    buffer.push(line);
  });
  flush(fence ? fencedKind : "paragraph");
  return orderSegments(out);
}
export function makeSegments(
  text: string,
  block: number,
  kind: Segment["kind"] = "paragraph",
  location: Segment["location"] = {},
): Segment[] {
  const parts = kind === "code" || kind === "math" ? [text] : sentences(text);
  return parts.map((part, i) => ({
    id: `b${block}s${i}`,
    block,
    order: 0,
    text: part,
    kind,
    eligible: !["code", "math"].includes(kind) && isEnglish(part),
    location,
  }));
}
export function orderSegments(segments: Segment[]): Segment[] {
  return segments.map((s, order) => ({ ...s, order }));
}
export function selectReferences(
  doc: Document,
  ids: string[],
  translations: Record<string, string> = {},
): Reference[] {
  const selected = new Set(ids);
  return doc.segments
    .filter((s) => selected.has(s.id))
    .map((s) => ({
      id: s.id,
      segmentId: s.id,
      revision: doc.revision,
      text: s.text,
      translation: translations[s.id],
      location: s.location,
    }));
}
export function referenceIds(text: string, refs: Reference[]): string[] {
  const allowed = new Set(refs.map((r) => r.id));
  return [...text.matchAll(/\[ref:([^\]]+)\]/g)]
    .map((m) => m[1])
    .filter((id) => allowed.has(id));
}
export function languageFor(path: string): string {
  return (
    (
      {
        rs: "rust",
        py: "python",
        js: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        c: "c",
        h: "c",
        cpp: "cpp",
        hpp: "cpp",
        cc: "cpp",
        java: "java",
        go: "go",
        cs: "csharp",
        json: "json",
        html: "html",
        css: "css",
        sh: "shell",
        md: "markdown",
        toml: "ini",
        yaml: "yaml",
        yml: "yaml",
      } as Record<string, string>
    )[path.split(".").pop()?.toLowerCase() || ""] || "plaintext"
  );
}
export function sourceLabel(s: Segment | Reference): string {
  return s.location.page
    ? `p. ${s.location.page}`
    : s.location.line
      ? `L${s.location.line}${s.location.endLine && s.location.endLine !== s.location.line ? `–${s.location.endLine}` : ""}`
      : "本文";
}
