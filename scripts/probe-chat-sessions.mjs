import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(".tools/session-probe-" + randomUUID());
await mkdir(root, { recursive: true });
const first = join(root, "first.txt");
const original = "Read the original.\n";
await writeFile(first, original);

const socket = createServer();
await new Promise((done) => socket.listen(0, "127.0.0.1", done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
let vite, child, browser;
async function ready(action) {
  for (let n = 0; n < 120; n++) {
    try {
      const result = await action();
      if (result) return result;
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("Native probe did not become ready");
}
async function launch() {
  child = spawn(resolve("src-tauri/target/debug/gradia.exe"), [], {
    env: {
      ...process.env,
      STUDY_TOOL_TEST_DATA_DIR: join(root, "data"),
      WEBVIEW2_USER_DATA_FOLDER: join(root, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
    },
    windowsHide: true,
    stdio: "ignore",
  });
  browser = await ready(() =>
    chromium.connectOverCDP("http://127.0.0.1:" + port),
  );
  const page = await ready(() =>
    browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes(":1420")),
  );
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  return page;
}
async function stop() {
  if (browser) {
    await browser.close();
    browser = null;
  }
  if (child && child.exitCode === null) {
    const ended = new Promise((done) => child.once("exit", done));
    child.kill();
    await ended;
  }
}
try {
  if (
    !(await fetch("http://127.0.0.1:1420")
      .then((r) => r.ok)
      .catch(() => false))
  )
    vite = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
      { windowsHide: true, stdio: "ignore" },
    );
  await ready(() => fetch("http://127.0.0.1:1420").then((r) => r.ok));
  let page = await launch();
  const doc = await page.evaluate(async (path) => {
    const { api } = await import("/src/api.ts");
    const { extractText } = await import("/src/core.ts");
    const f = await api.read(path);
    return api.save({
      title: f.name,
      source: f.path,
      kind: "text",
      content: f.content,
      segments: extractText(f.content),
      warnings: [],
      ratio: 0,
      position: null,
    });
  }, first);
  await page.reload();
  const select = page.getByLabel("会話セッション");
  await expect(select.locator("option")).toHaveCount(1);
  await expect(select).not.toHaveValue("");
  const firstSession = await select.inputValue();
  await page.getByRole("button", { name: "新しい会話を作成" }).click();
  await expect(select.locator("option")).toHaveCount(2);
  const secondSession = await select.inputValue();
  assert.notEqual(firstSession, secondSession);
  await select.selectOption(firstSession);
  await stop();
  const db = new DatabaseSync(join(root, "data/study.sqlite3"));
  const insert = db.prepare("INSERT INTO session_messages VALUES(?,?,?,?)");
  for (const [id, text] of [
    [firstSession, "最初の会話の履歴"],
    [secondSession, "別の会話の履歴"],
  ])
    insert.run(
      "message-" + id,
      id,
      JSON.stringify({
        id: "message-" + id,
        sessionId: id,
        role: "user",
        text,
        status: "completed",
        references: [],
        createdAt: 1,
      }),
      1,
    );
  db.close();
  page = await launch();
  await expect(
    page.getByText("最初の会話の履歴", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("会話セッション").selectOption(secondSession);
  await expect(page.getByText("別の会話の履歴", { exact: true })).toBeVisible();
  await expect(page.getByText("最初の会話の履歴", { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: "test-results/chat-sessions.png",
    fullPage: true,
  });
  await stop();
  page = await launch();
  await expect(page.getByLabel("会話セッション")).toHaveValue(secondSession);
  await expect(page.getByText("別の会話の履歴", { exact: true })).toBeVisible();
  assert.equal(await readFile(first, "utf8"), original);
  if (process.argv.includes("--delete")) {
    await page.getByRole("button", { name: "会話を削除" }).click();
    await page.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(
      page.getByLabel("会話セッション").locator("option"),
    ).toHaveCount(2);
    for (const expected of [firstSession, ""]) {
      await page.getByRole("button", { name: "会話を削除" }).click();
      await page.getByRole("button", { name: "削除する", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "会話を削除" }),
      ).toHaveCount(0);
      await expect(page.getByLabel("会話セッション")).toHaveValue(expected);
    }
    assert.equal(
      await page.evaluate(
        async (doc) =>
          (
            await (
              await import("/src/api.ts")
            ).api.sessions(doc.id, doc.revision)
          ).length,
        doc,
      ),
      0,
    );
    await expect(
      page.getByText("最初の会話の履歴", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("別の会話の履歴", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.locator(".document-item")).toHaveCount(1);
    await page.getByRole("button", { name: "新しい会話を作成" }).click();
    await expect(page.getByLabel("会話セッション")).not.toHaveValue("");
    const fresh = await page.getByLabel("会話セッション").inputValue();
    assert.notEqual(fresh, firstSession);
    assert.notEqual(fresh, secondSession);
    await stop();
    page = await launch();
    await expect(page.getByLabel("会話セッション")).toHaveValue(fresh);
    await expect(
      page.getByText("最初の会話の履歴", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("別の会話の履歴", { exact: true })).toHaveCount(
      0,
    );
    console.log(
      "Native conversation deletion, last session, fresh start and restart passed.",
    );
  }
  console.log(
    "Native session creation, separate history, switching and restart passed.",
  );
} finally {
  await stop();
  if (vite) vite.kill();
}
