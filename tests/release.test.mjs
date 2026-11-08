// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseTag,
  compareVersions,
  validateRelease,
  createReleaseArtifacts,
} from "../scripts/release-lib.mjs";
const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "gradia-release-"));
  dirs.push(root);
  await mkdir(resolve(root, "src-tauri"), { recursive: true });
  const files = {
    "package.json": { version: "0.2.0" },
    "package-lock.json": {
      version: "0.2.0",
      packages: { "": { version: "0.2.0" } },
    },
    "src-tauri/tauri.conf.json": {
      version: "0.2.0",
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: "test-public-key" } },
    },
  };
  for (const [file, value] of Object.entries(files))
    await writeFile(resolve(root, file), JSON.stringify(value));
  await writeFile(
    resolve(root, "src-tauri/Cargo.toml"),
    '[package]\nname = "gradia"\nversion = "0.2.0"\n',
  );
  await writeFile(
    resolve(root, "src-tauri/Cargo.lock"),
    '[[package]]\nname = "gradia"\nversion = "0.2.0"\n',
  );
  await writeFile(
    resolve(root, "CHANGELOG.md"),
    "# Changes\n\n## [0.2.0] - 2026-11-08\n\n- New updates.\n\n## [0.1.0]\n\n- Old notes.\n",
  );
  return root;
}
describe("release policy", () => {
  it("accepts stable and RC tags and rejects malformed or unsafe names", () => {
    expect(parseTag("v0.2.0").prerelease).toBe(false);
    expect(parseTag("v1.0.0-rc.1").prerelease).toBe(true);
    for (const tag of [
      "0.2.0",
      "v01.2.0",
      "v0.2.0;cmd",
      "v0.2.0-alpha",
      "v65536.0.0",
    ])
      expect(() => parseTag(tag)).toThrow();
  });
  it("orders numeric versions and release candidates without downgrading", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-rc.9")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
  });
  it("requires the tag and all manifests/locks to agree", async () => {
    const root = await fixture();
    await expect(validateRelease("v0.2.0", root)).resolves.toMatchObject({
      version: "0.2.0",
    });
    await writeFile(resolve(root, "src-tauri/Cargo.toml"), 'version = "0.1.0"');
    await expect(validateRelease("v0.2.0", root)).rejects.toThrow("Cargo.toml");
  });
  it("rejects releases without notes or updater signing enabled", async () => {
    const root = await fixture();
    await writeFile(resolve(root, "CHANGELOG.md"), "# No notes");
    await expect(validateRelease("v0.2.0", root)).rejects.toThrow("CHANGELOG");
  });
  it("creates a Windows-only manifest with signature and matching checksums", async () => {
    const root = await fixture(),
      source = resolve(root, "installers"),
      destination = resolve(root, "release");
    await mkdir(source);
    await writeFile(
      resolve(source, "Gradia_0.2.0_x64-setup.exe"),
      "MZtest-installer",
    );
    await writeFile(
      resolve(source, "Gradia_0.2.0_x64-setup.exe.sig"),
      "c2lnbmF0dXJl\n",
    );
    const result = await createReleaseArtifacts({
      root,
      tag: "v0.2.0",
      source,
      destination,
      date: "2026-11-08T00:00:00Z",
    });
    expect(result.manifest.platforms["windows-x86_64"].url).toBe(
      "https://github.com/k-zshiba/Gradia/releases/download/v0.2.0/Gradia_0.2.0_x64-setup.exe",
    );
    expect(result.manifest.platforms["windows-x86_64"].signature).toBe(
      "c2lnbmF0dXJl",
    );
    expect(result.manifest.notes).toBe("- New updates.");
    expect(
      (await readFile(resolve(destination, "SHA256SUMS"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(3);
    await rm(resolve(source, "Gradia_0.2.0_x64-setup.exe.sig"));
    await expect(
      createReleaseArtifacts({ root, tag: "v0.2.0", source, destination }),
    ).rejects.toThrow();
  });
});
