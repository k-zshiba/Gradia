import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
const sources = {
  nsis: {
    repo: "tauri-apps/binary-releases",
    tag: "nsis-3.13",
    name: "nsis-3.13.zip",
    sha256: "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8",
  },
  utils: {
    repo: "tauri-apps/nsis-tauri-utils",
    tag: "nsis_tauri_utils-v0.5.3",
    name: "nsis_tauri_utils.dll",
  },
};
const source = sources[process.argv[2]],
  destination = process.argv[3];
if (!source || !destination)
  throw new Error("Usage: download-bundler.mjs nsis|utils destination");
const headers = {
  "User-Agent": "Gradia-release-build",
  ...(process.env.GH_TOKEN
    ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
    : {}),
};
async function fetchRetry(url, accept) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { ...headers, Accept: accept },
        signal: AbortSignal.timeout(60000),
      });
      if (r.ok) return r;
      if (r.status < 500 && r.status !== 429)
        throw new Error(`GitHub download failed (${r.status})`);
    } catch (e) {
      if (attempt === 3) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error("GitHub download failed after retries");
}
const release = await (
  await fetchRetry(
    `https://api.github.com/repos/${source.repo}/releases/tags/${source.tag}`,
    "application/vnd.github+json",
  )
).json();
const asset = release.assets.find((a) => a.name === source.name);
if (!asset) throw new Error("Bundler asset not found");
const expected = source.sha256 || asset.digest?.replace(/^sha256:/, "");
if (!/^[0-9a-f]{64}$/.test(expected || ""))
  throw new Error("Official SHA-256 is required");
const bytes = Buffer.from(
  await (await fetchRetry(asset.url, "application/octet-stream")).arrayBuffer(),
);
if (createHash("sha256").update(bytes).digest("hex") !== expected)
  throw new Error("Bundler checksum mismatch");
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, bytes);
console.log(`Verified ${source.name}`);
