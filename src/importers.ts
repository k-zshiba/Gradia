import DOMPurify from "dompurify";
import { Readability } from "@mozilla/readability";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  isEnglish,
  makeSegments,
  orderSegments,
  languageFor,
  extractText,
} from "./core";
import type { LocalFile, Segment, Document } from "./types";

GlobalWorkerOptions.workerSrc = pdfWorker;
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
export { monaco, getDocument };
export const pdfOptions = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  useSystemFonts: true,
};

export function extractWeb(
  html: string,
  url: string,
): { title: string; segments: Segment[]; warnings: string[] } {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "form",
      "input",
      "object",
      "embed",
    ],
    FORBID_ATTR: ["style"],
  });
  const dom = new DOMParser().parseFromString(clean, "text/html");
  const base = dom.createElement("base");
  base.href = url;
  dom.head.prepend(base);
  const article = new Readability(dom).parse();
  if (!article?.content || !article.textContent?.trim())
    throw new Error(
      "記事本文を取得できません。ログインやJavaScriptが必要なページには対応していません。",
    );
  const body = new DOMParser().parseFromString(
    DOMPurify.sanitize(article.content),
    "text/html",
  );
  const segments: Segment[] = [];
  let block = 0;
  function inline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (!(node instanceof Element)) return "";
    if (node.tagName === "CODE") return "`" + (node.textContent || "") + "`";
    if (node.tagName === "math" || node.tagName === "MATH")
      return "$" + (node.textContent || "") + "$";
    if (node.tagName === "A") {
      const text = node.textContent || "";
      try {
        const href = new URL(node.getAttribute("href") || "", url);
        if (["http:", "https:"].includes(href.protocol))
          return `[${text}](${href.href})`;
      } catch {
        /* retain text */
      }
      return text;
    }
    if (node.tagName === "BR") return "\n";
    return Array.from(node.childNodes).map(inline).join("");
  }
  for (const el of body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,pre,li,table")) {
    if (el.parentElement?.closest("pre,li,table")) continue;
    const kind: Segment["kind"] = /^H\d$/.test(el.tagName)
      ? "heading"
      : el.tagName === "PRE" || el.tagName === "TABLE"
        ? "code"
        : el.tagName === "LI"
          ? "list"
          : "paragraph";
    const text = kind === "code" ? el.textContent || "" : inline(el);
    if (text.trim())
      segments.push(
        ...makeSegments(text.trim(), block++, kind, {
          anchor: el.id || undefined,
        }),
      );
  }
  if (!segments.length)
    segments.push(...makeSegments(article.textContent, block));
  return {
    title: article.title || new URL(url).hostname,
    segments: orderSegments(segments),
    warnings: ["図・画像は元ページで確認できます。表は原文を保持します。"],
  };
}

export async function extractCode(
  text: string,
  path: string,
): Promise<{ segments: Segment[]; language: string; warnings: string[] }> {
  const language = languageFor(path);
  // Load the editor's registered tokenizer before asking it for classified tokens.
  const registration = monaco.languages
    .getLanguages()
    .find((l) => l.id === language);
  const loader = (
    registration as typeof registration & {
      loader?: () => Promise<{ language: monaco.languages.IMonarchLanguage }>;
    }
  )?.loader;
  if (loader) {
    const grammar = await loader();
    monaco.languages.setMonarchTokensProvider(language, grammar.language);
  }
  const lines = text.split("\n");
  const tokens = monaco.editor.tokenize(text, language);
  const segments: Segment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const list = tokens[i] || [];
    segments.push({
      id: `line${i + 1}`,
      block: i,
      order: 0,
      text: line,
      kind: "code",
      eligible: false,
      location: { line: i + 1, endLine: i + 1 },
    });
    list.forEach((token, j) => {
      if (!token.type.split(".").includes("comment")) return;
      const comment = line
        .slice(token.offset, list[j + 1]?.offset ?? line.length)
        .replace(/^\s*(\/\/[/!]?|\/\*+|\*|#)\s?/, "")
        .replace(/\*\/\s*$/, "")
        .trim();
      if (isEnglish(comment))
        segments.push(
          ...makeSegments(comment, lines.length + i * 100 + j, "comment", {
            line: i + 1,
            endLine: i + 1,
          }),
        );
    });
  }
  return {
    segments: orderSegments(segments),
    language,
    warnings: segments.some((s) => s.kind === "comment")
      ? []
      : [
          "翻訳可能なコメントは見つかりませんでした。コードを選択してAIに質問できます。",
        ],
  };
}

export async function extractPdf(
  bytes: Uint8Array,
  onProgress?: (page: number, total: number) => void,
): Promise<{ segments: Segment[]; warnings: string[] }> {
  const loadingTask = getDocument({ ...pdfOptions, data: bytes.slice() });
  const segments: Segment[] = [];
  const warnings: string[] = [];
  let block = 0;
  try {
    const pdf = await loadingTask.promise;
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      onProgress?.(pageNo, pdf.numPages);
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const items = content.items.filter(
        (item): item is import("pdfjs-dist/types/src/display/api").TextItem =>
          "str" in item && !!item.str.trim(),
      );
      if (!items.length) {
        warnings.push(
          `p.${pageNo}: 文字情報がありません。原本表示で確認してください。`,
        );
        continue;
      }
      const width = page.view[2] - page.view[0];
      const columns =
        items.some((i) => i.transform[4] > width * 0.52) &&
        items.some((i) => i.transform[4] < width * 0.2);
      if (columns)
        warnings.push(
          `p.${pageNo}: 段組み・表の読み順は原本と照合してください。`,
        );
      // Preserve PDF item order; geometry gives an honest route back to the source.
      let parts: string[] = [];
      let rect: number[] = [];
      const flush = () => {
        if (parts.length) {
          segments.push(
            ...makeSegments(
              parts.join(" ").replace(/-\s+(?=[a-z])/g, ""),
              block++,
              "paragraph",
              { page: pageNo, rect },
            ),
          );
          parts = [];
          rect = [];
        }
      };
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const x = item.transform[4],
          y = item.transform[5];
        if (
          parts.length &&
          rect.length &&
          Math.abs(y - rect[1]) > Math.max(30, item.height * 2.5)
        )
          flush();
        if (!rect.length) rect = [x, y, item.width, item.height];
        parts.push(item.str);
        if (
          (item.hasEOL && /[.!?:]$/.test(item.str.trim())) ||
          parts.join(" ").length > 900
        )
          flush();
      }
      flush();
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return { segments: orderSegments(segments), warnings };
}

export async function importFile(
  file: LocalFile,
  onProgress?: (page: number, total: number) => void,
): Promise<Omit<Document, "id" | "revision" | "createdAt">> {
  const common = {
    title: file.name,
    kind: file.kind,
    source: file.path,
    content: file.content || "",
    ratio: 0,
    position: null,
  };
  if (file.kind === "pdf")
    return {
      ...common,
      ...(await extractPdf(new Uint8Array(file.bytes || []), onProgress)),
    };
  if (file.kind === "code")
    return { ...common, ...(await extractCode(common.content, file.path)) };
  const segments = extractText(common.content);
  return { ...common, segments, warnings: [] };
}
