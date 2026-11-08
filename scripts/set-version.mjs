import { readFile, writeFile } from "node:fs/promises";
import { parseVersion } from "./release-lib.mjs";
const { version } = parseVersion(process.argv[2]);
for (const path of [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
]) {
  const json = JSON.parse(await readFile(path, "utf8"));
  json.version = version;
  if (path === "package-lock.json") json.packages[""].version = version;
  await writeFile(path, JSON.stringify(json, null, 2) + "\n");
}
const cargo = await readFile("src-tauri/Cargo.toml", "utf8");
await writeFile(
  "src-tauri/Cargo.toml",
  cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
);
const lock = await readFile("src-tauri/Cargo.lock", "utf8");
await writeFile(
  "src-tauri/Cargo.lock",
  lock.replace(
    /(\[\[package\]\]\r?\nname = "gradia"\r?\nversion = ")[^"]+(")/,
    (_, start, end) => start + version + end,
  ),
);
console.log(
  `Version set to ${version}. Add its CHANGELOG.md section before tagging.`,
);
