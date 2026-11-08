import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(".tools/material-probe-" + randomUUID());
await mkdir(root, { recursive: true });
await mkdir("test-results", { recursive: true });
const code =
  'fn main() {\n    let text = "// Keep this string unchanged";\n    // Read the current value.\n    println!("{text}");\n}\n';
const codePath = resolve(root, "reference.rs");
await writeFile(codePath, code);
const stream =
  "BT /F1 14 Tf 50 750 Td (Memory has an owner. The owner manages its lifetime.) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [i, obj] of objects.entries()) {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
}
const xref = pdf.length;
pdf +=
  `xref\n0 6\n0000000000 65535 f \n` +
  offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("") +
  `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const pdfPath = resolve(root, "reference.pdf");
await writeFile(pdfPath, pdf);
const html =
  '<html><head><title>Web reference</title></head><body><article><h1>Ownership guide</h1><p>Ownership determines how a program manages memory. Each value has an owner. These rules prevent errors when references are shared.</p><pre><code>let text = "original";</code></pre><ul><li>Read the example.</li></ul><a href="/source">Original reference</a><script>window.injected=true</script></article></body></html>';
let localRequests = 0;
const server = createServer((_, res) => {
  localRequests++;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + server.address().port;
const port = 9231;
const child = spawn(resolve("src-tauri/target/debug/gradia.exe"), [], {
  env: {
    ...process.env,
    STUDY_TOOL_TEST_DATA_DIR: resolve(root, "data"),
    WEBVIEW2_USER_DATA_FOLDER: resolve(root, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
  },
  stdio: "ignore",
});
let browser;
try {
  for (let n = 0; n < 100; n++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  assert(browser);
  let page;
  for (let n = 0; n < 100; n++) {
    page = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes(":1420"));
    if (page) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert(page);
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const imported = await page.evaluate(
    async ({ codePath, pdfPath, url, html }) => {
      const { api } = await import("/src/api.ts");
      const { importFile, extractWeb } = await import("/src/importers.ts");
      const code = await api.save(await importFile(await api.read(codePath)));
      const pdf = await api.save(await importFile(await api.read(pdfPath)));
      let localRejected = false;
      try {
        await api.fetch(url);
      } catch {
        localRejected = true;
      }
      const source = "https://example.org/gradia-fixture";
      const article = extractWeb(html, source);
      const web = await api.save({
        ...article,
        kind: "web",
        source,
        content: "",
        ratio: 0,
        position: null,
      });
      return {
        code,
        pdf,
        web,
        pdfBytes: await api.pdf(pdf.id, pdf.revision),
        injected: window.injected,
        localRejected,
      };
    },
    { codePath, pdfPath, url, html },
  );
  assert(imported.localRejected, "Private URL was accepted");
  assert.equal(localRequests, 0, "Private server received an HTTP request");
  assert.equal(imported.code.content, code);
  assert.deepEqual(
    imported.code.segments
      .filter((s) => s.kind === "comment")
      .map((s) => s.text),
    ["Read the current value."],
  );
  assert.equal(imported.pdf.segments[0].location.page, 1);
  assert.equal(imported.pdf.segments[0].location.rect.length, 4);
  assert.deepEqual(Buffer.from(imported.pdfBytes), await readFile(pdfPath));
  assert(
    imported.web.segments.some(
      (s) => s.kind === "code" && s.text.includes("let text"),
    ),
  );
  assert(
    !imported.web.segments.some((s) => s.text.includes("window.injected")),
  );
  assert.equal(imported.injected, undefined);
  await page.reload();
  await page.getByRole("button", { name: /reference.pdf/ }).click();
  await expect(page.locator("article")).toContainText("Memory has an owner.");
  await page.getByRole("button", { name: /原本を開く/ }).click();
  await expect(page.getByRole("dialog", { name: "PDF原本" })).toBeVisible();
  await page.waitForFunction(
    () => document.querySelector(".pdf-canvas canvas")?.width > 500,
  );
  await page.screenshot({ path: "test-results/native-pdf.png" });
  await page.getByRole("button", { name: "原本を閉じる" }).click();
  await page.getByRole("button", { name: /reference.rs/ }).click();
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(page.locator(".monaco-editor")).toContainText(
    "Keep this string unchanged",
  );
  await page.screenshot({ path: "test-results/native-code.png" });
  // Cancellation must finish a background job without affecting document reading.
  const cancelled = await page.evaluate(
    async ({ doc, modelPath, llamaPath }) => {
      const { api } = await import("/src/api.ts");
      const events = [];
      const off = await api.events((e) => events.push(e));
      await api.saveSettings({
        ...(await api.settings()),
        modelPath,
        llamaPath,
      });
      const job = await api.translate(
        doc.id,
        doc.revision,
        doc.segments.filter((s) => s.eligible).map((s) => s.id),
      );
      await api.cancel(job);
      for (let n = 0; n < 50; n++) {
        const e = events.find((e) => e.jobId === job && e.status !== "running");
        if (e) {
          off();
          return e;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      off();
      throw new Error("No terminal translation event");
    },
    {
      doc: imported.code,
      modelPath: resolve(".tools/models/plamo-3-translate-2b-Q4_K_M.gguf"),
      llamaPath: resolve(".tools/llama/llama-server.exe"),
    },
  );
  assert.equal(cancelled.status, "interrupted");
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    checks: [
      "native PDF extraction and snapshot",
      "PDF original canvas",
      "native Monaco code view and comment positions",
      "private HTTP requests refused and Web fixtures sanitized",
      "translation cancellation/failure keeps reader usable",
    ],
    pageErrors: errors,
  };
  await writeFile(
    "test-results/native-materials.json",
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  if (browser) await browser.close();
  child.kill();
  server.close();
}
