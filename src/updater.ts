import { Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { call } from "./api";

export type AppUpdate = Pick<
  Update,
  "version" | "currentVersion" | "body" | "download" | "install" | "close"
>;
let startup: Promise<AppUpdate | null> | undefined;

export async function checkForUpdate(): Promise<AppUpdate | null> {
  const metadata = await call<ConstructorParameters<typeof Update>[0] | null>(
    "check_release_update",
  );
  return metadata ? new Update(metadata) : null;
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
