import { makeSegments, orderSegments } from "./core";
import type { Document, Translation } from "./types";
const blocks = [
  ["heading", "Understanding ownership"],
  [
    "paragraph",
    "Ownership is a set of rules that governs how a Rust program manages memory. These rules are checked at compile time.",
  ],
  ["heading", "A different way to think about memory"],
  [
    "paragraph",
    "Every value in Rust has an owner. There can only be one owner at a time. When the owner goes out of scope, the value will be dropped.",
  ],
  [
    "paragraph",
    "This simple idea makes it possible to write programs that are both safe and efficient. You can reason about the lifetime of a value by looking at the structure of your code.",
  ],
  [
    "code",
    'fn main() {\n    let message = String::from("Hello, world!");\n    println!("{message}");\n}',
  ],
  ["heading", "Borrowing a value"],
  [
    "paragraph",
    "A reference allows you to use a value without taking ownership of it. Think of borrowing as temporarily using a book from a library. The library remains the owner of the book.",
  ],
  [
    "paragraph",
    "Use the reference to read the value, then let it go. The original owner can continue to manage its memory.",
  ],
];
export const previewDocument: Document = {
  id: "sample",
  revision: "preview",
  title: "Understanding ownership",
  kind: "text",
  source: "アプリに付属する操作サンプル",
  createdAt: 0,
  content: "",
  ratio: 0,
  position: null,
  warnings: [],
  segments: orderSegments(
    blocks.flatMap(([kind, text], i) =>
      makeSegments(text, i, kind as "heading" | "paragraph" | "code"),
    ),
  ),
};
const japanese = [
  "所有権を理解する",
  "所有権は、Rustプログラムがメモリーを管理する方法を定める規則の集合である。",
  "これらの規則はコンパイル時に検査される。",
  "メモリーに対する別の考え方",
  "Rustのすべての値には所有者がいる。",
  "同時に存在できる所有者は1つだけである。",
  "所有者がスコープを抜けると、その値は破棄される。",
  "この単純な考え方によって、安全で効率的なプログラムを書ける。",
  "コードの構造を見ることで、値の生存期間について考えられる。",
  "",
  "値を借用する",
  "参照を使うと、所有権を取得せずに値を使用できる。",
  "借用は、図書館から本を一時的に借りることに似ている。",
  "本の所有者は図書館のままである。",
  "参照を使って値を読み、使い終えたら手放す。",
  "元の所有者は引き続きメモリーを管理できる。",
];
export const previewTranslations: Record<string, Translation> =
  Object.fromEntries(
    previewDocument.segments.map((s, i) => [
      s.id,
      { segmentId: s.id, text: japanese[i] || s.text, status: "ready" },
    ]),
  );
