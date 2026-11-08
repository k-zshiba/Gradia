import { appendFile } from "node:fs/promises";
import { validateRelease, readVersions } from "./release-lib.mjs";
const tag =
  process.argv[2] ||
  process.env.RELEASE_TAG ||
  "v" + (await readVersions())["package.json"];
const release = await validateRelease(tag);
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `version=${release.version}\nprerelease=${release.prerelease}\n`,
  );
console.log(
  `Validated ${tag}: all versions match; signed updater enabled; changelog present.`,
);
