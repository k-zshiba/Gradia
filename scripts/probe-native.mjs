// Requires a debug desktop build and Vite on port 1420.
// Owns an isolated application process, database and WebView profile.
import { chromium, expect } from "@playwright/test";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

await mkdir("test-results", { recursive: true });
const fixture = resolve("test-results/native-reading.md");
const original =
  '# Memory safety\n\nOwnership controls how a Rust program manages memory. Each value has one owner.\n\nUse `read_value()` to read the value. The formula is $x^2$.\n\n```rust\nlet value = "unchanged";\n```\n';
await writeFile(fixture, original);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const dataRoot = resolve(".tools/native-probe-" + randomUUID());
const env = {
  ...process.env,
  STUDY_TOOL_TEST_DATA_DIR: dataRoot,
  WEBVIEW2_USER_DATA_FOLDER: resolve(dataRoot, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
};
let child, browser;
async function launch() {
  child = spawn(resolve("src-tauri/target/debug/gradia.exe"), [], {
    env,
    stdio: "ignore",
  });
  for (let n = 0; n < 120; n++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert(browser, "Native debugging endpoint was not ready");
  for (let n = 0; n < 120; n++) {
    const page = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes(":1420"));
    if (page) {
      await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
      return page;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Native WebView was not ready");
}
try {
  let page = await launch();
  assert(page, "Native WebView was not found");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const settings = {
    llamaPath: resolve(".tools/llama/llama-server.exe"),
    modelPath: resolve(".tools/models/plamo-3-translate-2b-Q4_K_M.gguf"),
    gpuLayers: 0,
    codexPath: process.env.STUDY_CODEX_PATH || "codex.exe",
    codexModel: "",
  };
  const document = await page.evaluate(
    async ({ fixture, settings }) => {
      const { api } = await import("/src/api.ts");
      const { importFile } = await import("/src/importers.ts");
      await api.saveSettings(settings);
      return api.save(await importFile(await api.read(fixture)));
    },
    { fixture, settings },
  );
  await page.reload();
  await page
    .getByRole("button", { name: /native-reading.md/ })
    .first()
    .click();
  await expect(page.locator(".article h1")).toHaveText("native-reading.md");
  await page.evaluate(async () => {
    window.__nativeEvents = [];
    const { api } = await import("/src/api.ts");
    await api.events((e) => window.__nativeEvents.push(e));
  });
  let slider = page.getByRole("slider", { name: "日本語の割合" });
  const total = document.segments.filter((s) => s.eligible).length;
  await slider.fill("100");
  await expect(page.locator('[data-translated="true"]')).toHaveCount(total, {
    timeout: 180000,
  });
  const translations = await page.evaluate(async (doc) => {
    const { api } = await import("/src/api.ts");
    return api.translations(doc.id, doc.revision);
  }, document);
  assert.equal(Object.keys(translations).length, total);
  assert(
    Object.values(translations).some((t) => t.text.includes("`read_value()`")),
  );
  assert(Object.values(translations).some((t) => t.text.includes("$x^2$")));
  const listeningPort = Number(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$engine = Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Where-Object Name -eq 'llama-server.exe'; Get-NetTCPConnection -State Listen -OwningProcess $engine.ProcessId | Select-Object -First 1 -ExpandProperty LocalPort`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim(),
  );
  assert(listeningPort > 0, "Owned translation server was not found");
  const denied = await fetch(
    `http://127.0.0.1:${listeningPort}/v1/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "unauthorized request", max_tokens: 1 }),
    },
  );
  assert.equal(
    denied.status,
    401,
    "Translation accepted a request without the per-process key",
  );
  await slider.fill("50");
  await expect(page.locator('[data-translated="true"]')).toHaveCount(
    Math.round(total / 2),
  );
  const halfway = await page
    .locator('[data-translated="true"]')
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.segment));
  await slider.fill("0");
  await expect(page.locator('[data-translated="true"]')).toHaveCount(0);
  const before = await page.evaluate(() => window.__nativeEvents.length);
  await slider.fill("100");
  await expect(page.locator('[data-translated="true"]')).toHaveCount(total);
  await slider.fill("50");
  assert.deepEqual(
    await page
      .locator('[data-translated="true"]')
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.segment)),
    halfway,
  );
  await page.waitForTimeout(800);
  assert.equal(
    await page.evaluate(() => window.__nativeEvents.length),
    before,
    "Cached slider change launched a job",
  );
  assert.equal(
    hash(await readFile(fixture)),
    hash(original),
    "Original was modified",
  );
  await page.evaluate(async () =>
    (await import("/src/api.ts")).api.stopEngine(),
  );
  await browser.close();
  browser = null;
  child.kill();
  await new Promise((r) => setTimeout(r, 1500));
  page = await launch();
  page.on("pageerror", (e) => errors.push(e.message));
  slider = page.getByRole("slider", { name: "日本語の割合" });
  await page
    .getByRole("button", { name: /native-reading.md/ })
    .first()
    .click();
  await expect(slider).toHaveValue("50");
  await expect(page.locator('[data-translated="true"]')).toHaveCount(
    Math.round(total / 2),
  );
  await page.screenshot({ path: "test-results/native-reader.png" });
  // Exercise the real Rust failure path without requiring authentication or an API key.
  const failure = await page.evaluate(async (doc) => {
    const { api } = await import("/src/api.ts");
    const s = doc.segments.find((s) => s.eligible);
    const refs = [
      {
        id: s.id,
        segmentId: s.id,
        revision: doc.revision,
        text: s.text,
        location: s.location,
      },
    ];
    const events = [];
    const unlisten = await api.events((e) => events.push(e));
    const job = await api.chat(
      doc.id,
      doc.revision,
      "この文を説明してください。",
      refs,
    );
    for (let n = 0; n < 100; n++) {
      const event = events.find(
        (e) => e.jobId === job && e.status !== "running",
      );
      if (event) {
        unlisten();
        return { event, history: await api.history(doc.id, doc.revision) };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    unlisten();
    throw new Error("Chat failure did not arrive");
  }, document);
  assert.equal(failure.event.status, "failed");
  assert(failure.history.some((m) => m.status === "failed"));
  await expect(slider).toBeEnabled();
  // Import a new revision; the old one and its references stay intact.
  await writeFile(
    fixture,
    original + "\nA second revision preserves the first one.\n",
  );
  const revisions = await page.evaluate(async (fixture) => {
    const { api } = await import("/src/api.ts");
    const { importFile } = await import("/src/importers.ts");
    const next = await api.save(await importFile(await api.read(fixture)));
    return { next, all: await api.list() };
  }, fixture);
  assert.notEqual(revisions.next.revision, document.revision);
  assert.equal(revisions.all.filter((d) => d.id === document.id).length, 2);
  assert.deepEqual(errors, []);
  await page.evaluate(async () =>
    (await import("/src/api.ts")).api.stopEngine(),
  );
  const report = {
    passed: true,
    eligibleSentences: total,
    translations,
    checks: [
      "native IPC",
      "SQLite persistence after application restart",
      "real PLaMo translation",
      "translation server refuses unauthenticated inference",
      "code and formula preservation",
      "0/50/100 slider",
      "cache without new jobs",
      "immutable original",
      "chat failure/history",
      "immutable revisions",
    ],
    pageErrors: errors,
  };
  await writeFile(
    "test-results/native-probe.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  child?.kill();
}
