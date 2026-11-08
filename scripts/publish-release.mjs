import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createReleaseArtifacts, compareVersions } from "./release-lib.mjs";
const repository = process.env.GITHUB_REPOSITORY || "k-zshiba/Gradia";
const tag = process.env.RELEASE_TAG;
const result = await createReleaseArtifacts({ tag, repository });
function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr || "GitHub CLI failed");
  return r.stdout;
}
function api(path) {
  const r = spawnSync("gh", ["api", path], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status === 0) return JSON.parse(r.stdout);
  if (r.stderr.includes("HTTP 404")) return null;
  throw new Error("Cannot read GitHub Release state: " + r.stderr);
}
const existing = api(`repos/${repository}/releases/tags/${tag}`);
if (existing && !existing.draft)
  throw new Error("Published releases are immutable; use a new version/tag");
if (!result.release.prerelease) {
  const latest = api(`repos/${repository}/releases/latest`);
  if (
    latest &&
    compareVersions(
      result.release.version,
      latest.tag_name.replace(/^v/, ""),
    ) <= 0
  )
    throw new Error(
      "A stable release must be newer than the published latest version",
    );
}
if (!existing)
  gh([
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--draft",
    "--verify-tag",
    "--title",
    `Gradia ${tag}`,
    "--notes-file",
    resolve(result.destination, "release-notes.md"),
  ]);
gh([
  "release",
  "upload",
  tag,
  "--repo",
  repository,
  "--clobber",
  ...result.assets.map((name) => resolve(result.destination, name)),
]);
gh([
  "release",
  "edit",
  tag,
  "--repo",
  repository,
  "--draft=false",
  `--prerelease=${result.release.prerelease}`,
  `--latest=${!result.release.prerelease}`,
]);
console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
