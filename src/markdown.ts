import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import { mathToMarkdown } from "mdast-util-math";
import type { Definition, Nodes, PhrasingContent, Root } from "mdast";
import { isEnglish } from "./core";
import type { Segment } from "./types";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const extensions = [gfmToMarkdown(), mathToMarkdown()];
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path);
export const referenceKey = (id: string) =>
  id.trim().replace(/\s+/g, " ").toUpperCase();

function markdownDefinitions(root: Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  function visit(node: Nodes) {
    if (
      node.type === "definition" &&
      !definitions.has(referenceKey(node.identifier))
    )
      definitions.set(referenceKey(node.identifier), node);
    if ("children" in node) node.children.forEach(visit);
  }
  visit(root);
  return definitions;
}

export function markdownImageUrls(source: string): string[] {
  const root = parser.parse(source);
  const definitions = markdownDefinitions(root);
  const urls = new Set<string>();
  function visit(node: Nodes) {
    if (node.type === "image") urls.add(node.url);
    if (node.type === "imageReference") {
      const url = definitions.get(referenceKey(node.identifier))?.url;
      if (url) urls.add(url);
    }
    if ("children" in node) node.children.forEach(visit);
  }
  visit(root);
  return [...urls];
}

export interface MarkdownDocument {
  root: Root;
  segments: Segment[];
  nodeSegments: Map<Nodes, Segment[]>;
  originals: Map<string, PhrasingContent[]>;
  gaps: Map<string, PhrasingContent[]>;
  definitions: Map<string, Definition>;
  anchors: Map<string, string>;
  pages: Segment[][];
}

export function matchesMarkdown(
  document: MarkdownDocument,
  saved: Segment[],
): boolean {
  return (
    document.segments.length === saved.length &&
    document.segments.every((segment, i) => {
      const original = saved[i];
      return (
        (["id", "text", "block", "order", "kind", "eligible"] as const).every(
          (key) => segment[key] === original[key],
        ) &&
        (["line", "endLine", "anchor"] as const).every(
          (key) => segment.location[key] === original.location[key],
        )
      );
    })
  );
}

function projection(node: PhrasingContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "break") return "\n";
  if ("children" in node) return node.children.map(projection).join("");
  // Periods in code, math, image URLs and HTML cannot define prose sentence boundaries.
  return "\uE000";
}

function sentenceRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const part of segmenter.segment(text)) {
    const start =
      part.index + part.segment.length - part.segment.trimStart().length;
    const end = part.index + part.segment.trimEnd().length;
    if (start >= end) continue;
    const previous = ranges.at(-1);
    if (
      previous &&
      /\b(?:Mr|Mrs|Ms|Dr|Prof|vs|e\.g|i\.e)\.$/i.test(
        text.slice(previous.start, previous.end),
      )
    )
      previous.end = end;
    else ranges.push({ start, end });
  }
  return ranges;
}

function sliceInline(
  nodes: PhrasingContent[],
  start: number,
  end: number,
): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  let offset = 0;
  for (const node of nodes) {
    const length = projection(node).length;
    const from = Math.max(0, start - offset),
      to = Math.min(length, end - offset);
    if (from < to) {
      if (node.type === "text")
        result.push({ ...node, value: node.value.slice(from, to) });
      else if ("children" in node)
        result.push({
          ...node,
          children: sliceInline(node.children, from, to),
        } as PhrasingContent);
      else result.push(node);
    }
    offset += length;
  }
  return result;
}

export function inlineMarkdown(
  nodes: PhrasingContent[],
  definitions: Map<string, Definition>,
): string {
  function resolve(node: PhrasingContent): PhrasingContent {
    if (node.type === "linkReference" || node.type === "imageReference") {
      const definition = definitions.get(referenceKey(node.identifier));
      if (definition)
        return node.type === "linkReference"
          ? {
              type: "link",
              url: definition.url,
              title: definition.title,
              children: node.children.map(resolve) as typeof node.children,
            }
          : {
              type: "image",
              url: definition.url,
              title: definition.title,
              alt: node.alt,
            };
    }
    return "children" in node
      ? ({ ...node, children: node.children.map(resolve) } as PhrasingContent)
      : node;
  }
  return toMarkdown(
    {
      type: "root",
      children: [{ type: "paragraph", children: nodes.map(resolve) }],
    },
    { extensions },
  ).trimEnd();
}

export function parseInlineMarkdown(text: string): PhrasingContent[] {
  const root = parser.parse(text);
  return root.children.flatMap((node): PhrasingContent[] => {
    if (node.type === "paragraph" || node.type === "heading")
      return node.children;
    return [{ type: "text", value: "value" in node ? String(node.value) : "" }];
  });
}

export function parseMarkdown(source: string): MarkdownDocument {
  const root = parser.parse(source);
  const document: MarkdownDocument = {
    root,
    segments: [],
    nodeSegments: new Map(),
    originals: new Map(),
    gaps: new Map(),
    definitions: markdownDefinitions(root),
    anchors: new Map(),
    pages: [],
  };
  const slugs = new Set<string>();
  let block = 0;
  function visit(node: Nodes, inList = false): Segment[] {
    const items: Segment[] = [];
    const location = {
      line: node.position?.start.line,
      endLine: node.position?.end.line,
      anchor: undefined as string | undefined,
    };
    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "tableCell"
    ) {
      const plain = node.children.map(projection).join("");
      if (node.type === "heading") {
        function label(node: PhrasingContent): string {
          if ("children" in node) return node.children.map(label).join("");
          return node.type === "text" ||
            node.type === "inlineCode" ||
            node.type === "inlineMath"
            ? node.value
            : "";
        }
        const slug =
          node.children
            .map(label)
            .join("")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_\s-]/gu, "")
            .trim()
            .replace(/\s+/g, "-") || "heading";
        let occurrence = 0;
        location.anchor = slug;
        while (slugs.has(location.anchor))
          location.anchor = `${slug}-${++occurrence}`;
        slugs.add(location.anchor);
      }
      let cursor = 0;
      const currentBlock = block++;
      for (const [index, { start, end }] of sentenceRanges(plain).entries()) {
        const sentence = plain.slice(start, end);
        const gap = sliceInline(node.children, cursor, start);
        cursor = end;
        const original = sliceInline(node.children, start, cursor);
        const segment: Segment = {
          id: `m${node.position?.start.offset ?? currentBlock}s${index}`,
          block: currentBlock,
          order: document.segments.length + items.length,
          text: inlineMarkdown(original, document.definitions),
          kind:
            node.type === "heading" ? "heading" : inList ? "list" : "paragraph",
          eligible: isEnglish(sentence.replace(/\uE000/g, "")),
          location: { ...location },
        };
        document.originals.set(segment.id, original);
        document.gaps.set(segment.id, gap);
        items.push(segment);
      }
      if (location.anchor && items[0])
        document.anchors.set(location.anchor, items[0].id);
    } else if (
      node.type === "code" ||
      node.type === "math" ||
      node.type === "html"
    ) {
      const currentBlock = block++;
      items.push({
        id: `m${node.position?.start.offset ?? currentBlock}s0`,
        block: currentBlock,
        order: document.segments.length,
        text: node.value,
        kind: node.type === "math" ? "math" : "code",
        eligible: false,
        location,
      });
    } else if ("children" in node) {
      for (const child of node.children)
        items.push(...visit(child, inList || node.type === "listItem"));
      document.nodeSegments.set(node, items);
      return items;
    }
    document.nodeSegments.set(node, items);
    document.segments.push(...items);
    return items;
  }
  visit(root);
  let page: Segment[] = [];
  for (const node of root.children) {
    const segments = document.nodeSegments.get(node) || [];
    if (page.length && page.length + segments.length > 80) {
      document.pages.push(page);
      page = [];
    }
    page.push(...segments);
  }
  if (page.length || !document.pages.length) document.pages.push(page);
  return document;
}
