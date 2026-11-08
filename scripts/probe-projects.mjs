import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(".tools/project-probe-" + randomUUID());
const folder = join(root, "materials");
await mkdir(join(folder, "nested"), { recursive: true });
await mkdir(join(folder, "node_modules"));
await mkdir("test-results", { recursive: true });
const first = join(root, "first.md");
const second = join(root, "second.txt");
const broken = join(root, "broken.txt");
const original = "# Reading\n\nThe first sentence. The second sentence.\n";
await writeFile(first, original);
await writeFile(second, "Another reference.\n");
await writeFile(broken, Buffer.from([0xff, 0xfe]));
await writeFile(join(folder, "notes.md"), "Folder notes.\n");
await writeFile(
  join(folder, "nested", "code.rs"),
  "// Read the current value.\nfn main() {}\n",
);
await writeFile(
  join(folder, "node_modules", "ignored.js"),
  "// Not a study source.\n",
);
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
  const running = await fetch("http://127.0.0.1:1420")
    .then((r) => r.ok)
    .catch(() => false);
  if (!running)
    vite = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
      { windowsHide: true, stdio: "ignore" },
    );
  await ready(() => fetch("http://127.0.0.1:1420").then((r) => r.ok), "Vite");
  let page = await launch();
  await page.getByRole("button", { name: "プロジェクトを作成" }).click();
  await page.getByLabel("プロジェクト名").fill("Rust learning");
  await page.getByRole("button", { name: "作成", exact: true }).click();
  await expect(
    page.getByLabel("プロジェクト", { exact: true }),
  ).not.toHaveValue("");
  const rust = await page
    .getByLabel("プロジェクト", { exact: true })
    .inputValue();
  await page.evaluate(
    (paths) => (window.__pickedPaths = paths),
    [first, broken, second],
  );
  await page.getByRole("button", { name: "資料を追加", exact: true }).click();
  console.log("Picker selected multiple files");
  await Promise.race([
    page.getByRole("dialog", { name: "取り込み結果" }).waitFor(),
    page
      .getByRole("alert")
      .waitFor()
      .then(async () => {
        throw new Error(await page.getByRole("alert").innerText());
      }),
  ]);
  await expect(
    page.getByRole("dialog", { name: "取り込み結果" }),
  ).toContainText("2件を追加しました。1件を読み込めませんでした。", {
    timeout: 30000,
  });
  await expect(
    page.getByRole("dialog", { name: "取り込み結果" }),
  ).toContainText("UTF-8");
  await page.getByRole("button", { name: "資料を読む" }).click();
  await expect(page.locator(".library .document-item")).toHaveCount(2);
  await page.evaluate((path) => (window.__pickedPaths = path), folder);
  await page.getByRole("button", { name: "フォルダーを追加" }).click();
  await expect(
    page.getByRole("dialog", { name: "取り込み結果" }),
  ).toContainText("2件を追加しました。", { timeout: 30000 });
  await page.getByRole("button", { name: "資料を読む" }).click();
  await expect(page.locator(".library .document-item")).toHaveCount(4);
  await expect(page.locator(".library").getByText("ignored.js")).toHaveCount(0);
  await page.getByRole("button", { name: "プロジェクトを作成" }).click();
  await page.getByLabel("プロジェクト名").fill("Books");
  await page.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.locator(".library .document-item")).toHaveCount(0);
  const books = await page
    .getByLabel("プロジェクト", { exact: true })
    .inputValue();
  await page.getByRole("button", { name: "既存の資料を選ぶ・外す" }).click();
  await page.getByRole("checkbox", { name: /first.md/ }).click();
  await expect(page.getByRole("checkbox", { name: /first.md/ })).toBeChecked();
  await page
    .getByRole("dialog", { name: "プロジェクトの資料" })
    .getByRole("button", { name: "閉じる" })
    .click();
  await page
    .locator(".library")
    .getByRole("button", { name: /first.md/ })
    .click();
  await expect(page.locator(".article h1")).toHaveText("first.md");
  await page.getByRole("slider", { name: "日本語の割合" }).fill("50");
  await page.getByRole("switch", { name: "英語と日本語を併記" }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { api } = await import("/src/api.ts");
        return (await api.list()).find((d) => d.title === "first.md")
          ?.bilingual;
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: "プロジェクトを管理" }).click();
  await page.getByLabel("プロジェクト名").fill("Reading books");
  await page.getByRole("button", { name: "名前を保存" }).click();
  await expect(
    page.getByRole("option", { name: "Reading books（1）" }),
  ).toHaveCount(1);
  await stop();
  page = await launch();
  await expect(page.getByLabel("プロジェクト", { exact: true })).toHaveValue(
    books,
  );
  await expect(page.locator(".article h1")).toHaveText("first.md");
  await expect(
    page.getByRole("switch", { name: "英語と日本語を併記" }),
  ).toBeChecked();
  await page.getByRole("switch", { name: "英語と日本語を併記" }).click();
  await expect(page.getByRole("slider", { name: "日本語の割合" })).toHaveValue(
    "50",
  );
  await page.getByRole("button", { name: "既存の資料を選ぶ・外す" }).click();
  await page.getByRole("checkbox", { name: /first.md/ }).click();
  await expect(
    page.getByRole("checkbox", { name: /first.md/ }),
  ).not.toBeChecked();
  await expect(page.locator(".library .document-item")).toHaveCount(0);
  await page
    .getByRole("dialog", { name: "プロジェクトの資料" })
    .getByRole("button", { name: "閉じる" })
    .click();
  await page.getByRole("button", { name: "プロジェクトを管理" }).click();
  await page.getByRole("button", { name: "プロジェクトを削除" }).click();
  await page.getByRole("button", { name: "削除する", exact: true }).click();
  await expect(page.getByLabel("プロジェクト", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.locator(".library .document-item")).toHaveCount(4);
  await page.getByLabel("プロジェクト", { exact: true }).selectOption(rust);
  await expect(page.locator(".library .document-item")).toHaveCount(4);
  await page.screenshot({ path: "test-results/projects.png", fullPage: true });
  assert.equal(await readFile(first, "utf8"), original);
  console.log(
    "Native projects: multiple files, partial failure, nested folder, shared references, rename, restart, bilingual persistence, ratio restoration, removal, deletion and source preservation passed.",
  );
} finally {
  await stop();
  if (vite) vite.kill();
}
