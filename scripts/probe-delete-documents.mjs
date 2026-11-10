import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(".tools/delete-probe-" + randomUUID());
await mkdir(root, { recursive: true });
const first = join(root, "first.txt"),
  second = join(root, "second.txt");
const original = "Read the original.\n";
await writeFile(first, original);
await writeFile(second, original);
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
  ) {
    vite = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
      { windowsHide: true, stdio: "ignore" },
    );
  }
  await ready(() => fetch("http://127.0.0.1:1420").then((r) => r.ok));
  let page = await launch();
  const add = async (path) =>
    page.evaluate(async (path) => {
      const { api } = await import("/src/api.ts");
      const { extractText } = await import("/src/core.ts");
      const file = await api.read(path);
      return api.save({
        title: file.name,
        source: file.path,
        kind: "text",
        content: file.content,
        segments: extractText(file.content),
        warnings: [],
        ratio: 0,
        position: null,
      });
    }, path);
  const old = await add(first);
  const other = await add(second);
  await writeFile(first, "Read the new version.\n");
  const latest = await add(first);
  await page.reload();
  await page
    .locator(".document-item")
    .filter({ hasText: "first.txt" })
    .first()
    .click();
  await page.getByRole("button", { name: "資料を削除", exact: true }).click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  assert.equal(
    await page.evaluate(
      async () => (await (await import("/src/api.ts")).api.list()).length,
    ),
    3,
  );
  await page.evaluate(async (old) => {
    const { api } = await import("/src/api.ts");
    await api.deleteDocument(old.id, old.revision, false);
  }, old);
  assert.equal((await readdir(join(root, "data/snapshots"))).length, 2);
  await page.reload();
  await page
    .locator(".document-item")
    .filter({ hasText: "first.txt" })
    .click();
  await page.getByRole("button", { name: "資料を削除", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "この資料のすべての版を削除する" })
    .check();
  await page.getByRole("button", { name: "削除する", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "資料を削除" })).toHaveCount(0);
  await expect(
    page.locator(".document-item").filter({ hasText: "first.txt" }),
  ).toHaveCount(0);
  assert.equal((await readdir(join(root, "data/snapshots"))).length, 1);
  await page.evaluate(async (other) => {
    const { api } = await import("/src/api.ts");
    await api.deleteDocument(other.id, other.revision, true);
  }, other);
  assert.equal((await readdir(join(root, "data/snapshots"))).length, 0);
  assert.equal(await readFile(first, "utf8"), "Read the new version.\n");
  assert.equal(await readFile(second, "utf8"), original);
  assert.notEqual(old.revision, latest.revision);
  await stop();
  page = await launch();
  assert.equal(
    await page.evaluate(
      async () => (await (await import("/src/api.ts")).api.list()).length,
    ),
    0,
  );
  console.log(
    "Native document deletion, cancellation, shared snapshots, original files and restart passed.",
  );
} finally {
  await stop();
  if (vite) vite.kill();
}


