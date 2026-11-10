import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, symlink, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(".tools/markdown-images-probe-" + randomUUID());
const folder = join(root, "materials");
const sourcePath = join(folder, "chapters/guide.md");
const imagePath = join(folder, "images/図 one.png");
await mkdir(join(folder, "chapters"), { recursive: true });
await mkdir(join(folder, "images"));
await mkdir(join(root, "external"));
await mkdir("test-results", { recursive: true });
const png = await readFile("src-tauri/icons/icon.png");
const source =
  "# Guide\n\nRead the figure. ![inline](../images/図%20one.png)\n\n![reference][PIC]\n\n[pic]: ../images/図%20one.png\n\n![outside](../../external/secret.png)\n\n![junction](../escape/secret.png)\n\n![remote](https://example.invalid/track.png)\n\n![active](../images/active.svg)\n";
await writeFile(sourcePath, source);
await writeFile(imagePath, png);
await writeFile(join(root, "external/secret.png"), png);
await writeFile(
  join(folder, "images/active.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__imageExecuted=true"><image href="https://example.invalid/svg.png"/></svg>',
);
await symlink(join(root, "external"), join(folder, "escape"), "junction");
const socket = createServer();
await new Promise((done) => socket.listen(0, "127.0.0.1", done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
let vite, child, browser;

async function ready(action, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const value = await action();
      if (value) return value;
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(description + " did not become ready");
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
  browser = await ready(
    () => chromium.connectOverCDP("http://127.0.0.1:" + port),
    "Native debugger",
  );
  const page = await ready(
    () =>
      browser
        .contexts()[0]
        .pages()
        .find((p) => p.url().includes(":1420")),
    "Native page",
  );
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  // Tauri's invoke is immutable; replacing the picker module leaves native storage and extraction intact.
  await page.route("**/*plugin-dialog*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "export async function open() { return window.__pickedPaths; }",
    }),
  );
  await page.reload();
  page.on("console", (event) => {
    if (event.type() === "error") console.error("WebView:", event.text());
  });
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
  await ready(() => fetch("http://127.0.0.1:1420").then((r) => r.ok), "Vite");
  let page = await launch();
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) requests.push(request.url());
  });
  await page.evaluate(async (path) => {
    const { api } = await import("/src/api.ts");
    let denied = false;
    try {
      await api.read(path, true);
    } catch (e) {
      denied = String(e).includes("フォルダー");
    }
    if (!denied) throw new Error("Unselected folder permission was accepted");
  }, sourcePath);
  async function importFolder() {
    await page.evaluate((path) => (window.__pickedPaths = path), folder);
    await page.getByRole("button", { name: "フォルダーを追加" }).click();
    await expect(
      page.getByRole("dialog", { name: "取り込み結果" }),
    ).toContainText("1件を追加しました");
    await page.getByRole("button", { name: "資料を読む", exact: true }).click();
    await expect(page.locator(".markdown-preview img")).toHaveCount(2);
    await expect
      .poll(() =>
        page
          .locator(".markdown-preview img")
          .evaluateAll((images) =>
            images.every((img) => img.complete && img.naturalWidth > 0),
          ),
      )
      .toBe(true);
  }
  await importFolder();
  const first = await page.evaluate(
    async () => (await (await import("/src/api.ts")).api.list())[0],
  );
  assert.equal(first.warnings.length, 4);
  const original = await page
    .locator(".markdown-preview img")
    .first()
    .getAttribute("src");
  assert.match(original, /^data:image\/png;base64,/);
  await expect(
    page.getByRole("img", { name: "outside", exact: true }),
  ).toHaveJSProperty("tagName", "SPAN");
  await expect(
    page.getByRole("img", { name: "junction", exact: true }),
  ).toHaveJSProperty("tagName", "SPAN");
  await expect(
    page.getByRole("img", { name: "active", exact: true }),
  ).toHaveJSProperty("tagName", "SPAN");
  assert.deepEqual(requests, []);
  assert.equal(await page.evaluate(() => window.__imageExecuted), undefined);
  assert.equal(await readFile(sourcePath, "utf8"), source);
  assert.deepEqual(await readFile(imagePath), png);
  await page.getByRole("switch", { name: "英語と日本語を併記" }).click();
  await expect(page.locator(".markdown-preview img")).toHaveCount(2);
  await page.screenshot({
    path: "test-results/markdown-folder-images.png",
    fullPage: true,
  });
  await page.getByRole("switch", { name: "英語と日本語を併記" }).click();
  await writeFile(
    imagePath,
    Buffer.concat([png, Buffer.from("changed image bytes")]),
  );
  await importFolder();
  const docs = await page.evaluate(async () =>
    (await import("/src/api.ts")).api.list(),
  );
  assert.equal(docs.length, 2);
  const second = docs.find((doc) => doc.revision !== first.revision);
  assert(second);
  const changed = await page
    .locator(".markdown-preview img")
    .first()
    .getAttribute("src");
  assert.notEqual(changed, original);
  await unlink(imagePath);
  await unlink(sourcePath);
  await stop();
  page = await launch();
  await expect(page.locator(".markdown-preview img")).toHaveCount(2);
  await expect(page.locator(".markdown-preview img").first()).toHaveAttribute(
    "src",
    changed,
  );
  await page.evaluate(
    (doc) => localStorage.setItem("study-active", doc.id + ":" + doc.revision),
    first,
  );
  await page.reload();
  await expect(page.locator(".markdown-preview img").first()).toHaveAttribute(
    "src",
    original,
  );
  await expect
    .poll(() =>
      page
        .locator(".markdown-preview img")
        .first()
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await page.evaluate(async (first) => {
    const { api } = await import("/src/api.ts");
    await api.deleteDocument(first.id, first.revision, false);
    if (Object.keys(await api.images(first.id, first.revision)).length)
      throw new Error("Deleted images remained");
  }, first);
  assert.equal(
    await page.evaluate(
      async (doc) =>
        Object.keys(
          await (await import("/src/api.ts")).api.images(doc.id, doc.revision),
        ).length,
      second,
    ),
    1,
  );
  console.log(
    "Native folder Markdown images, relative references, junction isolation, original files, image revisions, offline restart and deletion passed.",
  );
} finally {
  await stop();
  if (vite) vite.kill();
}
