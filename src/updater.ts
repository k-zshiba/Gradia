import {
  check,
  type Update,
  type DownloadEvent,
} from "@tauri-apps/plugin-updater";

export type AppUpdate = Pick<
  Update,
  "version" | "currentVersion" | "body" | "download" | "install" | "close"
>;
let startup: Promise<AppUpdate | null> | undefined;

export function checkForUpdate(): Promise<AppUpdate | null> {
  return check({ timeout: 15_000 });
}

// React StrictMode mounts effects twice in development; make one startup request.
export function checkAtStartup(): Promise<AppUpdate | null> {
  return (startup ??= checkForUpdate());
}

export async function installUpdate(
  update: AppUpdate,
  progress: (event: DownloadEvent) => void,
  beforeInstall: () => Promise<void>,
) {
  // The plugin validates the embedded public-key signature during download.
  // Keep current work running until download and verification both succeed.
  await update.download(progress, { timeout: 180_000 });
  await beforeInstall();
  await update.install({ restartAfterInstall: true });
}
