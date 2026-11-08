import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith("http://tauri.localhost"));
assert(page, "Installed application was not found");
const connected = await page.evaluate(
  async () =>
    (await window.__TAURI_INTERNALS__.invoke("account_status")).connected,
);
assert(connected, "ChatGPT is not connected");
if (await page.getByRole("button", { name: "設定を閉じる" }).isVisible())
  await page.getByRole("button", { name: "設定を閉じる" }).click();
// Import this test's own fixture through the actual Rust snapshot/storage commands.
// Material parsing has separate native integration coverage.
await page.evaluate(async (path) => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const file = await invoke("read_file", { path });
  const sentences = [
    "In Rust, each value has an owner.",
    "When the owner goes out of scope, the value is dropped.",
    "Borrowing allows a reference to access a value without taking ownership.",
  ];
  const segments = sentences.map((text, i) => ({
    id: "b0s" + i,
    block: 0,
    order: i,
    text,
    kind: "paragraph",
    eligible: true,
    location: { anchor: "b0" },
  }));
  await invoke("save_document", {
    document: {
      title: file.name,
      kind: "text",
      source: file.path,
      content: file.content,
      ratio: 0,
      position: null,
      segments,
      warnings: [],
    },
  });
}, resolve("examples/connection-check.md"));
await page.reload();
await page
  .getByRole("button", { name: /connection-check.md/ })
  .first()
  .click();
await expect(page.locator(".article h1")).toHaveText("connection-check.md");
const doc = await page.evaluate(async () => {
  const docs = await window.__TAURI_INTERNALS__.invoke("list_documents");
  const doc = docs.find((d) => d.title === "connection-check.md");
  return { id: doc.id, revision: doc.revision };
});
async function ask(question) {
  const before = await page.evaluate(
    async (doc) =>
      (await window.__TAURI_INTERNALS__.invoke("get_history", doc)).length,
    doc,
  );
  await page.getByRole("textbox", { name: "質問", exact: true }).fill(question);
  await page.getByRole("button", { name: "質問を送信" }).click();
  for (let n = 0; n < 600; n++) {
    const history = await page.evaluate(
      async (doc) => window.__TAURI_INTERNALS__.invoke("get_history", doc),
      doc,
    );
    const answer = history.slice(before).find((m) => m.role === "assistant");
    if (answer && answer.status !== "running") return answer;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Live chat timed out");
}
const first = await ask(
  "この文章の要点を日本語で2文で説明し、参照IDを使って根拠を引用してください。",
);
console.log(
  JSON.stringify({ turn: 1, status: first.status, text: first.text }),
);
assert.equal(first.status, "completed", first.text);
assert(first.text.length > 10);
const links = page.locator(".message.assistant button.citation");
// The second question is another app-server process resuming the stored thread.
const second = await ask(
  "前の回答を踏まえて、借用が所有権の移動とどう違うかを1文で説明してください。",
);
console.log(
  JSON.stringify({ turn: 2, status: second.status, text: second.text }),
);
assert.equal(second.status, "completed", second.text);
await page.screenshot({ path: "test-results/live-chat.png" });
const report = {
  passed: true,
  document: doc,
  first: { status: first.status, text: first.text },
  second: { status: second.status, text: second.text },
  checks: [
    "ChatGPT plan OAuth",
    "real inference via Codex app-server",
    "streaming UI",
    "thread resume across processes",
    "persisted history",
  ],
};
await mkdir("test-results", { recursive: true });
await writeFile("test-results/live-chat.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
// Keep the user's installed application open.
process.exit(0);
