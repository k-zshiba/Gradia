import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";

export function parseVersion(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/.exec(
      version,
    );
  if (!match || match.slice(1, 4).some((n) => Number(n) > 65535))
    throw new Error(
      "Version must be X.Y.Z or X.Y.Z-rc.N (each Windows version field <= 65535)",
    );
  return {
    version,
    parts: match.slice(1, 4).map(Number),
    prerelease: match[4] !== undefined,
    rc: match[4] === undefined ? null : Number(match[4]),
  };
}
export function parseTag(tag) {
  if (!tag?.startsWith("v")) throw new Error("Release tag must start with v");
  return parseVersion(tag.slice(1));
}
export function compareVersions(a, b) {
  const left = parseVersion(a),
    right = parseVersion(b);
  for (let i = 0; i < 3; i++)
    if (left.parts[i] !== right.parts[i])
      return Math.sign(left.parts[i] - right.parts[i]);
  if (left.prerelease !== right.prerelease) return left.prerelease ? -1 : 1;
  return Math.sign((left.rc ?? 0) - (right.rc ?? 0));
}
export async function readVersions(root = process.cwd()) {
  const json = async (p) =>
    JSON.parse(await readFile(resolve(root, p), "utf8"));
  const pkg = await json("package.json"),
    lock = await json("package-lock.json"),
    tauri = await json("src-tauri/tauri.conf.json");
  const cargo = await readFile(resolve(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoLock = await readFile(
    resolve(root, "src-tauri/Cargo.lock"),
    "utf8",
  );
  return {
    "package.json": pkg.version,
    "package-lock.json": lock.version,
    "package-lock root": lock.packages[""].version,
    "tauri.conf.json": tauri.version,
    "Cargo.toml": /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1],
    "Cargo.lock":
      /\[\[package\]\]\r?\nname = "gradia"\r?\nversion = "([^"]+)"/.exec(
        cargoLock,
      )?.[1],
  };
}
export async function validateRelease(tag, root = process.cwd()) {
  const release = parseTag(tag);
  for (const [file, version] of Object.entries(await readVersions(root)))
    if (version !== release.version)
      throw new Error(`${file}: ${version} does not match tag ${tag}`);
  const config = JSON.parse(
    await readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8"),
  );
  if (
    !config.bundle?.createUpdaterArtifacts ||
    !config.plugins?.updater?.pubkey
  )
    throw new Error("Signed updater artifacts must be enabled");
  await releaseNotes(release.version, root);
  return release;
}
export async function releaseNotes(version, root = process.cwd()) {
  parseVersion(version);
  const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find((s) => s.startsWith(`[${version}]`));
  if (!section || !section.split("\n").slice(1).join("\n").trim())
    throw new Error(`CHANGELOG.md needs release notes for ${version}`);
  return section.split("\n").slice(1).join("\n").trim();
}
export async function createReleaseArtifacts({
  root = process.cwd(),
  tag,
  repository = "k-zshiba/Gradia",
  source = resolve(root, "src-tauri/target/release/bundle/nsis"),
  destination = resolve(root, ".tools/release"),
  date = new Date().toISOString(),
}) {
  const release = await validateRelease(tag, root);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid repository name");
  const files = (await readdir(source)).filter(
    (f) => f.endsWith("_x64-setup.exe") && f.includes(`_${release.version}_`),
  );
  if (files.length !== 1)
    throw new Error(
      "Expected exactly one Windows x64 installer for this version",
    );
  const file = files[0],
    binary = await readFile(resolve(source, file));
  if (binary.length < 2 || binary.subarray(0, 2).toString() !== "MZ")
    throw new Error("Installer must be a Windows executable");
  const signature = (
    await readFile(resolve(source, file + ".sig"), "utf8")
  ).trim();
  if (!signature || !/^[A-Za-z0-9+/=]+$/.test(signature))
    throw new Error("Missing or invalid update signature");
  const notes = await releaseNotes(release.version, root);
  const platform = {
    signature,
    url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
  };
  const manifest = {
    version: release.version,
    notes,
    pub_date: date,
    platforms: { "windows-x86_64": platform, "windows-x86_64-nsis": platform },
  };
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, file), binary);
  await writeFile(resolve(destination, file + ".sig"), signature + "\n");
  await writeFile(
    resolve(destination, "latest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(resolve(destination, "release-notes.md"), notes + "\n");
  const assets = [file, file + ".sig", "latest.json"];
  const sums = await Promise.all(
    assets.map(
      async (name) =>
        createHash("sha256")
          .update(await readFile(resolve(destination, name)))
          .digest("hex") +
        "  " +
        basename(name),
    ),
  );
  await writeFile(resolve(destination, "SHA256SUMS"), sums.join("\n") + "\n");
  return { release, manifest, assets: [...assets, "SHA256SUMS"], destination };
}
