import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createServer as createSocket } from "node:net";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = resolve(
  root,
  ".tools/browser-native",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(run, { recursive: true });
await writeFile(
  resolve(run, "driver.mjs"),
  await readFile(fileURLToPath(import.meta.url)),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const findings = [];
async function report(name, result) {
  findings.push({ name, result });
  await writeFile(
    resolve(run, "findings.json"),
    JSON.stringify(findings, null, 2),
  );
  console.log(name, JSON.stringify(result));
}
async function port() {
  const socket = createSocket();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const value = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return value;
}
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out ${label}`);
}
const traffic = [];
const fixture = createServer((request, response) => {
  traffic.push(request.url);
  if (request.url === "/slow") {
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<p>Old delayed page.</p>");
      }
    }, 800);
    return;
  }
  if (request.url === "/download") {
    response.writeHead(200, {
      "Content-Disposition": "attachment; filename=blocked.txt",
    });
    response.end("blocked download");
    return;
  }
  if (request.url === "/auth") {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="blocked"' });
    response.end("Authentication denied");
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  });
  const sentences = request.url?.startsWith("/next")
    ? ["Destination content stays original."]
    : [
        "The library is open today.",
        "The book is on the table.",
        "Students read a short story.",
        "The garden has many flowers.",
        "The train arrives in the morning.",
        "This lesson explains the idea.",
        "We can learn a new language.",
        "A small bird sings outside.",
      ];
  response.end(`<!doctype html><html><head><title>日本語で読むWeb</title><style>body{font:20px Georgia;margin:36px;background:#e9f4f4;color:#142d38}h1{font:36px sans-serif;color:#156070}.grid{display:grid;grid-template-columns:2fr 1fr;gap:24px}.card{padding:24px;background:white;border-radius:14px}a{color:#096e85}#below{margin-top:900px}</style></head><body><h1>元サイトの表示</h1><div class="grid"><article class="card">${sentences.map((text, index) => `<p id="p${index}">${text}</p>`).join("")}<p id="mutable">Site content remains independent.</p><p id="inline">日本語の<strong>装飾</strong>と<a href="/next">リンク</a>を保持</p><a id="next" href="/next">次のページ</a> <a id="new-window" target="_blank" href="/next?new">新しいリンク</a> <a id="route" href="#chapter">目次</a></article><aside class="card"><p id="script-result">準備中</p><button id="counter-button">クリック</button><output id="counter">0</output><a id="download" href="/download" download>保存</a><a id="file" href="file:///C:/blocked.txt">ファイル</a><a id="external" href="gradia-test://blocked">外部</a><input id="input" value="Input must stay original."><pre id="code">Code must stay original.</pre><p hidden>Hidden content must be excluded.</p><div contenteditable>Editable content must be excluded.</div><iframe srcdoc="Frame content must be excluded."></iframe></aside></div><p id="below">Offscreen text is included.</p><script>
document.querySelector('#script-result').textContent='元のJavaScriptを実行';document.querySelector('#counter-button').onclick=()=>document.querySelector('#counter').textContent=Number(document.querySelector('#counter').textContent)+1;
window.attack={tauri:typeof window.__TAURI_INTERNALS__,public:typeof window.__TAURI__,ipc:typeof window.ipc,host:typeof window.chrome?.webview?.hostObjects,storage:Object.keys(localStorage)};
try{window.__TAURI_INTERNALS__.invoke('create_project',{name:'REMOTE SIDE EFFECT'})}catch{window.attack.invokeDenied=true}try{window.chrome.webview.postMessage({cmd:'create_project',name:'REMOTE SIDE EFFECT'})}catch{window.attack.postDenied=true}
fetch('http://ipc.localhost/',{method:'POST',body:JSON.stringify({cmd:'create_project',name:'REMOTE SIDE EFFECT',callback:1,error:2})}).catch(()=>{});window.open('/popup');Document.prototype.createTreeWalker=()=>{throw new Error('main world poison')};
</script></body></html>`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const trustedPort = await port(),
  remotePort = await port();
const env = {
  ...process.env,
  STUDY_TOOL_TEST_DATA_DIR: run,
  STUDY_TOOL_TEST_DEBUG_PORT: String(trustedPort),
  STUDY_TOOL_BROWSER_TEST_DEBUG_PORT: String(remotePort),
  STUDY_TOOL_BROWSER_TEST_ORIGIN: origin,
};
delete env.WEBVIEW2_USER_DATA_FOLDER;
delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
let app, trusted, remote, vite;
const remoteConnections = [];
let page, raw;
const errors = [];
async function connect(debugPort) {
  return until(
    async () => {
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      } catch {
        return null;
      }
    },
    "native debugging endpoint",
    60000,
  );
}
async function call(command, args = {}) {
  return page.evaluate(
    async ({ command, args }) =>
      (await import("/src/api.ts")).call(command, args),
    { command, args },
  );
}
async function current() {
  return page.evaluate(async () => {
    const status = document.querySelector(".browser-workspace");
    if (!status) return null;
    const { browserApi } = await import("/src/browser.ts");
    const id = status.dataset.sessionId;
    return id ? browserApi.status(id) : null;
  });
}
async function snapshot() {
  return until(async () => {
    const value = await current();
    return value?.snapshot;
  }, "page snapshot");
}
async function clickRaw(selector) {
  const point = await raw.evaluate((selector) => {
    const element = document.querySelector(selector);
    element.scrollIntoView({ block: "center", behavior: "instant" });
    const r = element.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  const client = await raw.context().newCDPSession(raw);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await client.detach();
}
async function rawText() {
  return raw.locator("#p0").textContent();
}
async function translatedCount(originals) {
  return raw.evaluate(
    (originals) =>
      originals.filter(
        ([id, text]) => document.getElementById(id)?.textContent !== text,
      ).length,
    originals,
  );
}
try {
  vite = spawn(
    process.execPath,
    [
      resolve(root, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "1420",
      "--strictPort",
    ],
    { cwd: root, stdio: "ignore", windowsHide: true },
  );
  await until(async () => {
    const result = await fetch("http://localhost:1420/src/browser.ts");
    return result.ok;
  }, "owned Vite");
  app = spawn(
    process.env.GRADIA_NATIVE_EXE ||
      resolve(root, "src-tauri/target/debug/gradia.exe"),
    [],
    { cwd: root, env, stdio: "ignore", windowsHide: true },
  );
  await writeFile(
    resolve(run, "owned-processes.json"),
    JSON.stringify({
      app: app.pid,
      vite: vite.pid,
      origin,
      trustedPort,
      remotePort,
    }),
  );
  trusted = await connect(trustedPort);
  page = await until(
    () =>
      trusted
        .contexts()[0]
        .pages()
        .find((page) => page.url().includes(":1420")),
    "trusted UI",
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await page.evaluate(async () => {
    window.__browserEvents = [];
    await (
      await import("/src/browser.ts")
    ).browserApi.events((event) => window.__browserEvents.push(event));
  });
  const project = await call("create_project", { name: "Web originals" });
  await page.reload();
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await page.evaluate(async () => {
    window.__browserEvents = [];
    await (
      await import("/src/browser.ts")
    ).browserApi.events((event) => window.__browserEvents.push(event));
  });
  await call("save_settings", {
    settings: {
      llamaPath:
        process.env.GRADIA_LLAMA_PATH ||
        resolve(root, ".tools/llama/llama-server.exe"),
      modelPath:
        process.env.GRADIA_MODEL_PATH ||
        resolve(root, ".tools/models/plamo-3-translate-2b-Q4_K_M.gguf"),
      gpuLayers: 0,
      codexPath: "codex.exe",
      codexModel: "",
    },
  });
  await page.getByRole("button", { name: "URLから追加", exact: true }).click();
  await page
    .getByRole("textbox", { name: "WebページのURL" })
    .fill(origin + "/");
  await page.getByRole("button", { name: "元ページを開く" }).click();
  remote = await connect(remotePort);
  remoteConnections.push(remote);
  raw = await until(
    () =>
      remote
        .contexts()[0]
        .pages()
        .find((page) => page.url().startsWith(origin)),
    "raw page",
  );
  await expect(raw.locator("#script-result")).toHaveText(
    "元のJavaScriptを実行",
  );
  let snap = await snapshot();
  assert.equal(snap.segments.filter((segment) => segment.eligible).length, 10);
  assert(
    snap.segments.some(
      (segment) => segment.text === "Offscreen text is included.",
    ),
  );
  assert(
    !snap.segments.some((segment) =>
      /Code must|Input must|Hidden content|Editable content|Frame content/.test(
        segment.text,
      ),
    ),
  );
  assert.equal(
    await raw
      .locator(".grid")
      .evaluate((element) => getComputedStyle(element).display),
    "grid",
  );
  const attack = await raw.evaluate(() => window.attack);
  assert.deepEqual(attack.storage, []);
  assert.equal(attack.tauri, "undefined");
  assert.equal(attack.public, "undefined");
  assert.equal(attack.ipc, "undefined");
  assert.equal(attack.invokeDenied, true);
  assert.equal(
    (await call("list_projects")).some(
      (project) => project.name === "REMOTE SIDE EFFECT",
    ),
    false,
  );
  await raw.screenshot({ path: resolve(run, "original.png") });
  await report("original layout and isolated extraction", {
    eligible: 10,
    attack,
    screenshot: "original.png",
    xFrameOptions: "DENY",
  });
  const originals = await raw
    .locator("#p0,#p1,#p2,#p3,#p4,#p5,#p6,#p7,#mutable,#below")
    .evaluateAll((elements) =>
      elements.map((element) => [element.id, element.textContent]),
    );
  const slider = page.getByRole("slider", { name: "日本語の割合" });
  await slider.fill("100");
  await page.getByRole("button", { name: "不足分を翻訳" }).click();
  await until(
    async () => {
      const value = await snapshot();
      return value.jobId && Object.keys(value.translations).length >= 1;
    },
    "inference started",
    180000,
  );
  const cancelling = await snapshot();
  await call("cancel_job", { jobId: cancelling.jobId });
  await until(async () => !(await snapshot()).jobId, "inference cancellation");
  const cancelledCount = Object.keys((await snapshot()).translations).length;
  await sleep(400);
  assert.equal(
    Object.keys((await snapshot()).translations).length,
    cancelledCount,
  );
  await report("cancel during real inference", { completed: cancelledCount });
  await page.getByRole("button", { name: "不足分を翻訳" }).click();
  await until(
    async () => {
      snap = await snapshot();
      return !snap.jobId && Object.keys(snap.translations).length === 10;
    },
    "real local PLaMo",
    240000,
  );
  assert.equal(await translatedCount(originals), 10);
  assert(/[\u3040-\u30ff\u3400-\u9fff]/.test(await rawText()));
  await raw.screenshot({ path: resolve(run, "translated.png") });
  const eventCount = await page.evaluate(() => window.__browserEvents.length);
  await slider.fill("50");
  await until(
    async () => (await translatedCount(originals)) === 5,
    "half translation",
  );
  const half = await raw
    .locator("#p0,#p1,#p2,#p3,#p4,#p5,#p6,#p7,#mutable,#below")
    .evaluateAll((elements) => elements.map((element) => element.textContent));
  await slider.fill("0");
  await until(
    async () => (await translatedCount(originals)) === 0,
    "original restore",
  );
  await slider.fill("100");
  await until(
    async () => (await translatedCount(originals)) === 10,
    "all cached",
  );
  await slider.fill("50");
  await until(
    async () => (await translatedCount(originals)) === 5,
    "half cached",
  );
  assert.deepEqual(
    await raw
      .locator("#p0,#p1,#p2,#p3,#p4,#p5,#p6,#p7,#mutable,#below")
      .evaluateAll((elements) =>
        elements.map((element) => element.textContent),
      ),
    half,
  );
  await page.getByRole("checkbox", { name: "原文と訳文を併記" }).check();
  await until(
    async () =>
      await rawText().then(
        (text) => text.includes(originals[0][1]) && text.includes("（"),
      ),
    "bilingual",
  );
  await page.getByRole("checkbox", { name: "原文と訳文を併記" }).uncheck();
  await until(
    async () => (await translatedCount(originals)) === 5,
    "ratio retained",
  );
  assert.equal(
    await page.evaluate(() => window.__browserEvents.length),
    eventCount,
  );
  await report("real PLaMo and cached ratios", {
    translations: snap.translations,
    half,
    eventCount,
    screenshot: "translated.png",
  });
  await page.getByRole("button", { name: "本文を再解析" }).click();
  const firstId = snap.id;
  snap = await until(async () => {
    const value = await snapshot();
    return value.id !== firstId ? value : null;
  }, "reanalysis");
  assert.equal(
    snap.segments.find((segment) => segment.eligible).text,
    originals[0][1],
  );
  await page.getByRole("button", { name: "不足分を翻訳" }).click();
  await until(async () => !(await snapshot()).jobId, "cached reanalysis job");
  const afterReanalysis = await page.evaluate(() =>
    window.__browserEvents
      .filter((event) => event.status === "running")
      .slice(-5),
  );
  assert(afterReanalysis.every((event) => event.cached));
  await raw.evaluate(() => {
    document.querySelector("#mutable").firstChild.data =
      "Site mutation must survive.";
    document.querySelector("#p1").outerHTML =
      '<p id="p1">Replacement must survive.</p>';
    document.querySelector("#counter-button").click();
  });
  await slider.fill("100");
  await page.getByRole("button", { name: "原文に戻す", exact: true }).click();
  await until(
    async () => (await rawText()) === originals[0][1],
    "conditional restore",
  );
  assert.equal(
    await raw.locator("#mutable").textContent(),
    "Site mutation must survive.",
  );
  assert.equal(
    await raw.locator("#p1").textContent(),
    "Replacement must survive.",
  );
  assert.equal(await raw.locator("#counter").textContent(), "1");
  assert.equal(
    await raw.locator("#code").textContent(),
    "Code must stay original.",
  );
  assert.equal(
    await raw.locator("#input").inputValue(),
    "Input must stay original.",
  );
  await report("reanalysis retains immutable originals and site changes", {
    afterReanalysis,
  });
  const hostRect = await page.locator(".browser-native-host").boundingBox();
  await page.locator(".browser-workspace").evaluate((element) => {
    element.style.width = "980px";
    element.style.height = "700px";
  });
  await until(
    async () => Math.abs((await raw.evaluate(() => innerWidth)) - 980) <= 1,
    "native resized width",
  );
  await page.getByRole("button", { name: "ページに移る" }).click();
  assert.equal(await raw.evaluate(() => document.hasFocus()), true);
  await raw.screenshot({ path: resolve(run, "resized.png") });
  await page.locator(".browser-workspace").evaluate((element) => {
    element.style.width = "";
    element.style.height = "";
  });
  await until(
    async () =>
      Math.abs((await raw.evaluate(() => innerWidth)) - hostRect.width) <= 1,
    "native restored width",
  );
  await report("native resize and focus", {
    width: 980,
    screenshot: "resized.png",
  });
  await raw.locator("#next").click();
  await expect(raw).toHaveURL(origin + "/next");
  const next = await until(async () => {
    const value = await snapshot();
    return value.url.endsWith("/next") ? value : null;
  }, "link snapshot");
  await assert.rejects(
    call("browser_display", {
      sessionId: next.sessionId,
      snapshotId: snap.id,
      segmentIds: [snap.segments.find((segment) => segment.eligible).id],
      bilingual: false,
    }),
  );
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await expect(raw).toHaveURL(origin + "/");
  await page.getByRole("button", { name: "進む", exact: true }).click();
  await expect(raw).toHaveURL(origin + "/next");
  const beforeReload = (await snapshot()).id;
  await page.getByRole("button", { name: "再読み込み", exact: true }).click();
  await until(
    async () => (await snapshot()).id !== beforeReload,
    "same URL reload snapshot",
  );
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await expect(raw).toHaveURL(origin + "/");
  await snapshot();
  await raw.locator("#new-window").click();
  await expect(raw).toHaveURL(origin + "/next?new");
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await expect(raw).toHaveURL(origin + "/");
  await clickRaw("#file");
  await sleep(200);
  assert.equal(raw.url(), origin + "/");
  await clickRaw("#external");
  await sleep(200);
  assert.equal(raw.url(), origin + "/");
  await clickRaw("#download");
  await sleep(250);
  assert.equal(raw.url(), origin + "/");
  assert.equal(
    await raw.evaluate(() => Notification.requestPermission()),
    "denied",
  );
  const overlap = await current();
  await call("browser_action", {
    sessionId: overlap.status.sessionId,
    action: { kind: "navigate", url: origin + "/slow" },
  });
  await sleep(80);
  await call("browser_action", {
    sessionId: overlap.status.sessionId,
    action: { kind: "navigate", url: origin + "/next" },
  });
  await until(async () => {
    const value = await current();
    return !value?.status.loading && value?.snapshot?.url === origin + "/next";
  }, "overlapping navigation");
  await sleep(1000);
  assert.equal((await current()).status.loading, false);
  assert.equal((await snapshot()).url, origin + "/next");
  await call("browser_action", {
    sessionId: overlap.status.sessionId,
    action: { kind: "navigate", url: origin + "/" },
  });
  await expect(raw).toHaveURL(origin + "/");
  await snapshot();
  await report("obsolete navigation completion stays ignored", {
    url: raw.url(),
  });
  await report("navigation history reload popups and deny policy", {
    url: raw.url(),
    traffic,
  });
  snap = await snapshot();
  await slider.fill("100");
  await page.getByRole("button", { name: "不足分を翻訳" }).click();
  await raw.locator("#route").click();
  await expect(raw).toHaveURL(origin + "/#chapter");
  snap = await until(async () => {
    const value = await snapshot();
    return value.url.endsWith("#chapter") ? value : null;
  }, "same document snapshot");
  assert.equal(
    snap.segments.find((segment) => segment.eligible).text,
    originals[0][1],
  );
  await page.getByRole("button", { name: "不足分を翻訳" }).click();
  await until(async () => !(await snapshot()).jobId, "route cache");
  const htmlBefore = await raw.locator("#inline").innerHTML();
  const savedOriginals = snap.segments.map((segment) => segment.text);
  await page
    .getByRole("combobox", { name: "本文の保存先" })
    .selectOption(project.id);
  await page.getByRole("button", { name: "原文を保存してAIに質問" }).click();
  await expect(page.locator(".browser-workspace")).toHaveCount(0);
  const saved = (await call("list_documents")).find(
    (document) => document.source === origin + "/#chapter",
  );
  assert(saved);
  assert.deepEqual(
    saved.segments.map((segment) => segment.text),
    savedOriginals,
  );
  assert.equal(saved.ratio, 0);
  assert(
    (await call("list_projects"))
      .find((value) => value.id === project.id)
      .documentKeys.includes(`${saved.id}:${saved.revision}`),
  );
  await expect(page.locator(".article h1")).toHaveText(saved.title);
  await report("original snapshot save to project and reader", {
    id: saved.id,
    revision: saved.revision,
    source: saved.source,
    segments: savedOriginals,
    inline: htmlBefore,
  });
  await page.getByRole("button", { name: "元ページ", exact: false }).click();
  await expect(page.locator(".browser-workspace")).toHaveCount(1);
  const reopened = await snapshot();
  const validSettings = await call("get_settings");
  await call("save_settings", {
    settings: { ...validSettings, modelPath: resolve(run, "missing.gguf") },
  });
  await call("browser_translate", {
    sessionId: reopened.sessionId,
    snapshotId: reopened.id,
    segmentIds: [reopened.segments.find((segment) => segment.eligible).id],
  });
  await until(async () => {
    const value = await snapshot();
    return !value.jobId && value.error;
  }, "missing model error");
  assert.equal(
    await page.getByRole("button", { name: "資料に戻る" }).isEnabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "設定", exact: true }).isEnabled(),
    true,
  );
  await call("save_settings", { settings: validSettings });
  await report("missing model preserves browsing and settings", {
    error: (await snapshot()).error,
  });
  if (process.env.GRADIA_PUBLIC_SMOKE === "1") {
    const live = await current();
    await call("browser_action", {
      sessionId: live.status.sessionId,
      action: { kind: "navigate", url: "https://example.com/" },
    });
    const publicPage = await until(
      async () => {
        const value = await current();
        return value?.snapshot?.url.startsWith("https://example.com/")
          ? value.snapshot
          : null;
      },
      "public HTTPS snapshot",
      60000,
    );
    assert.equal(publicPage.title, "Example Domain");
    assert(publicPage.segments.length > 0);
    await report("public HTTPS original page", {
      url: publicPage.url,
      title: publicPage.title,
      segments: publicPage.segments,
    });
  }
  if (process.env.GRADIA_PUBLIC_SMOKE === "1") {
    remote = await connect(remotePort);
    remoteConnections.push(remote);
    raw = await until(
      () =>
        remote
          .contexts()[0]
          .pages()
          .find((value) => !value.isClosed()),
      "reopened native target",
    );
    await raw.screenshot({ path: resolve(run, "public-https.png") });
    const href = await raw.locator("a").first().getAttribute("href");
    await clickRaw("a");
    await until(
      async () => raw.url() !== "https://example.com/",
      "public HTTPS link",
      60000,
    );
    await report("public HTTPS link", {
      href,
      url: raw.url(),
      screenshot: "public-https.png",
    });
  }
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "設定" })).toBeVisible();
  await assert.rejects(call("browser_status", { sessionId: snap.sessionId }));
  await page.screenshot({ path: resolve(run, "settings-after-close.png") });
  assert.deepEqual(errors, []);
  await report("close before settings", {
    pageErrors: errors,
    screenshot: "settings-after-close.png",
  });
  await call("stop_engine");
  const initializationRace = await page.evaluate(
    async ({ origin }) => {
      const { call } = await import("/src/api.ts");
      const sessionId = crypto.randomUUID();
      const opening = call("browser_open", {
        sessionId,
        url: origin + "/",
        bounds: { x: 0, y: 300, width: 700, height: 400 },
      }).then(
        () => "opened",
        () => "cancelled",
      );
      await call("browser_close", { sessionId });
      const result = await opening;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const absent = await call("browser_status", { sessionId }).then(
        () => false,
        () => true,
      );
      return { result, absent };
    },
    { origin },
  );
  assert.equal(initializationRace.absent, true);
  await report("close during initialization", initializationRace);
  await report("passed", { run });
} catch (error) {
  await report("FAILED", { message: error.message, stack: error.stack });
  try {
    if (page) await page.screenshot({ path: resolve(run, "failure-ui.png") });
    if (raw) await raw.screenshot({ path: resolve(run, "failure-page.png") });
  } catch {}
  process.exitCode = 1;
} finally {
  try {
    if (page) await call("stop_engine");
  } catch {}
  try {
    for (const connection of remoteConnections) await connection.close();
  } catch {}
  try {
    await trusted?.close();
  } catch {}
  app?.kill();
  vite?.kill();
  fixture.close();
  console.log("Artifacts", run);
}
