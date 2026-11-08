import { createReleaseArtifacts } from "./release-lib.mjs";
const result = await createReleaseArtifacts({
  tag: process.argv[2] || process.env.RELEASE_TAG,
  repository: process.env.GITHUB_REPOSITORY || "k-zshiba/Gradia",
});
console.log(`Prepared ${result.release.version}: ${result.assets.join(", ")}`);
