import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(".tools/markdown-probe-" + randomUUID());
await mkdir(root, { recursive: true });
await mkdir("test-results", { recursive: true });
const fixture = join(root, "reading.md");
const source =
  '# Memory\n\nRead **the value** carefully. Keep `read_value()` unchanged.\n\n> Read the example.\n\n1. Read the guide.\n   - Check the value.\n\n| Term | Description |\n| --- | --- |\n| Memory | Every value has an owner. |\n\n```rust\nlet text = "original";\n```\n';
await writeFile(fixture, source);
const socket = createServer();
await new Promise((done) => socket.listen(0, "127.0.0.1", done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
let vite, child, browser;
async function ready(action, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const result = await action();
      if (result) return result;
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(label + " did not become ready");
}
async function launch() {
  child = spawn(resolve("src-tauri/target/debug/gradia.exe"), [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      STUDY_TOOL_TEST_DATA_DIR: join(root, "data"),
      WEBVIEW2_USER_DATA_FOLDER: join(root, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
    },
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
  return page;
}
async function stop() {
  if (browser) {
    const page = browser
      .contexts()[0]
      ?.pages()
      .find((p) => p.url().includes(":1420"));
    if (page) {
      try {
        await page.evaluate(async () => {
          const { api } = await import("/src/api.ts");
          await api.stopEngine();
        });
      } catch {}
    }
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
    .then((response) => response.ok)
    .catch(() => false);
  if (!running)
    vite = spawn(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
      { windowsHide: true, stdio: "ignore" },
    );
  await ready(
    () => fetch("http://127.0.0.1:1420").then((response) => response.ok),
    "Vite",
  );
  let page = await launch();
  const legacy = await page.evaluate(async (path) => {
    const { api } = await import("/src/api.ts");
    const { extractText } = await import("/src/core.ts");
    const file = await api.read(path);
    const project = await api.createProject("Markdown reading");
    const doc = await api.save(
      {
        title: file.name,
        kind: "text",
        source: file.path,
        content: file.content,
        segments: extractText(file.content),
        warnings: [],
        ratio: 50,
        bilingual: true,
        position: null,
      },
      project.id,
    );
    return { doc, project };
  }, fixture);
  await writeFile(fixture, "Changed after the snapshot.\n");
  await page.reload();
  await page
    .getByLabel("プロジェクト", { exact: true })
    .selectOption(legacy.project.id);
  await page.getByRole("button", { name: "Markdownプレビューに更新" }).click();
  await expect(page.locator(".markdown-preview h1")).toContainText("Memory");
  await expect(page.locator(".markdown-preview table")).toBeVisible();
  await expect(page.locator(".markdown-preview ol ul li")).toContainText(
    "Check the value.",
  );
  await expect(page.locator(".markdown-preview blockquote")).toContainText(
    "Read the example.",
  );
  await expect(page.locator(".markdown-preview pre code")).toHaveText(
    'let text = "original";',
  );
  await expect(
    page.getByRole("switch", { name: "英語と日本語を併記" }),
  ).toBeChecked();
  const upgraded = await page.evaluate(async (id) => {
    const { api } = await import("/src/api.ts");
    return (await api.list()).find(
      (d) => d.id === id && d.language === "markdown",
    );
  }, legacy.doc.id);
  assert(upgraded);
  assert.notEqual(upgraded.revision, legacy.doc.revision);
  assert.equal(upgraded.content, source);
  assert.equal(upgraded.ratio, 50);
  const memberships = await page.evaluate(async () => {
    const { api } = await import("/src/api.ts");
    return api.projects();
  });
  assert.equal(memberships[0].documentKeys.length, 2);
  console.log(
    "Saved Markdown upgraded without reading the changed original file; old revision and project membership retained.",
  );
  await writeFile(fixture, source);
  const saved = await page.evaluate(
    async ({ path, project }) => {
      const { api } = await import("/src/api.ts");
      const { importFile } = await import("/src/importers.ts");
      return api.save(await importFile(await api.read(path)), project);
    },
    { path: fixture, project: legacy.project.id },
  );
  assert.equal(saved.revision, upgraded.revision);
  if (process.env.STUDY_TOOL_REAL_TRANSLATION === "1") {
    await page.evaluate(
      async ({ llamaPath, modelPath }) => {
        const { api } = await import("/src/api.ts");
        await api.saveSettings({
          llamaPath,
          modelPath,
          gpuLayers: 0,
          codexPath: "codex.exe",
          codexModel: "",
        });
      },
      {
        llamaPath: resolve(".tools/llama/llama-server.exe"),
        modelPath: resolve(".tools/models/plamo-3-translate-2b-Q4_K_M.gguf"),
      },
    );
    await page.reload();
    const total = upgraded.segments.filter((s) => s.eligible).length;
    await expect(
      page.locator('.markdown-preview [data-translated="true"]'),
    ).toHaveCount(total, { timeout: 180000 });
    await expect(
      page.locator(".markdown-preview .bilingual-translation strong"),
    ).not.toHaveCount(0);
    await expect(
      page.locator(".markdown-preview .bilingual-translation code"),
    ).toHaveText("read_value()");
    await page.screenshot({
      path: "test-results/markdown-bilingual.png",
      fullPage: true,
    });
    await page.locator(".markdown-table").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "test-results/markdown-table-bilingual.png",
      fullPage: true,
    });
    await page.getByRole("switch", { name: "英語と日本語を併記" }).click();
    await expect(
      page.getByRole("slider", { name: "日本語の割合" }),
    ).toHaveValue("50");
    await expect(
      page.locator('.markdown-preview [data-translated="true"]'),
    ).toHaveCount(Math.round(total / 2));
    await page.getByRole("textbox", { name: "本文を検索" }).fill("owner");
    await page.locator(".search-results button").first().click();
    await expect(
      page.locator(".markdown-preview .segment.flash"),
    ).toBeVisible();
    console.log(
      "PLaMo translated Markdown with preserved bold/code, bilingual preview and percentage restoration.",
    );
  }
  await page.screenshot({
    path: "test-results/markdown-preview.png",
    fullPage: true,
  });
  await stop();
  page = await launch();
  await expect(page.locator(".markdown-preview table")).toBeVisible();
  assert.equal(await readFile(fixture, "utf8"), source);
  console.log(
    "Native Markdown preview, source mapping, immutable revisions and restart restoration passed.",
  );
} finally {
  await stop();
  if (vite) vite.kill();
}
