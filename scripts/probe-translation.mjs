import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import assert from "node:assert/strict";

const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const started = performance.now();
const server = spawn(
  resolve(".tools/llama/llama-server.exe"),
  [
    "-m",
    resolve(".tools/models/plamo-3-translate-2b-Q4_K_M.gguf"),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--alias",
    "plamo-3-translate",
    "-c",
    "8192",
    "--jinja",
    "--no-prefill-assistant",
    "-ngl",
    "0",
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
server.stdout.on("data", (b) => {
  log += b;
});
server.stderr.on("data", (b) => {
  log += b;
});
server.on("error", (e) => {
  log += String(e);
});
const endpoint = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let n = 0; n < 240; n++) {
    if (server.exitCode !== null)
      throw new Error(
        `llama-server exited: ${server.exitCode}\n${log.slice(-4000)}`,
      );
    try {
      ready = (await fetch(`${endpoint}/health`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(ready, "Model startup timed out");
  const startupSeconds = (performance.now() - started) / 1000;
  const examples = [
    [
      "Ownership is a set of rules that govern how a Rust program manages memory.",
      "This chapter explains memory safety in Rust.",
    ],
    [
      "Use ⟦KEEP_0⟧ to read the value.",
      "The original function name must stay unchanged.",
    ],
  ];
  const results = [];
  for (const [source, context] of examples) {
    const prompt = `<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>context<|plamo:msg|>${context}<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>${source}<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>plain<|plamo:msg|>`;
    const before = performance.now();
    const response = await fetch(`${endpoint}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "plamo-3-translate",
        prompt,
        temperature: 0,
        max_tokens: 2048,
        stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
      }),
      signal: AbortSignal.timeout(180000),
    });
    const body = await response.json();
    assert(response.ok, JSON.stringify(body));
    const translated = body.choices[0].text.trim();
    assert(
      /[\u3040-\u30ff\u4e00-\u9fff]/u.test(translated),
      "No Japanese translation",
    );
    if (source.includes("⟦KEEP_0⟧"))
      assert(
        translated.includes("⟦KEEP_0⟧"),
        "Protected code marker was changed",
      );
    results.push({
      source,
      translated,
      seconds: (performance.now() - before) / 1000,
      usage: body.usage,
    });
  }
  const report = {
    date: new Date().toISOString(),
    cpu: cpus()[0]?.model,
    ramGiB: totalmem() / 2 ** 30,
    gpuLayers: 0,
    startupSeconds,
    results,
  };
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/translation-probe.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.kill();
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/llama-server.log", log);
}
