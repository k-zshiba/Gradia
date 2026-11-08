import { beforeEach, it, expect, vi } from "vitest";
const mocked = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocked.check }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
it("deduplicates the startup query while manual checks remain retryable", async () => {
  const { checkAtStartup, checkForUpdate } = await import("../src/updater");
  mocked.check.mockResolvedValue(null);
  await Promise.all([checkAtStartup(), checkAtStartup()]);
  expect(mocked.check).toHaveBeenCalledTimes(1);
  await checkForUpdate();
  expect(mocked.check).toHaveBeenCalledTimes(2);
});
it("verifies the download before preparing shutdown and requesting restart", async () => {
  const { installUpdate } = await import("../src/updater");
  const order: string[] = [];
  const update = {
    version: "0.3.0",
    currentVersion: "0.2.0",
    download: vi.fn(async () => {
      order.push("download/verify");
    }),
    install: vi.fn(async () => {
      order.push("install");
    }),
    close: vi.fn(),
  };
  await installUpdate(update, vi.fn(), async () => {
    order.push("save/stop");
  });
  expect(order).toEqual(["download/verify", "save/stop", "install"]);
  expect(update.install).toHaveBeenCalledWith({ restartAfterInstall: true });
});
it("does not stop current work or run an installer when verification fails", async () => {
  const { installUpdate } = await import("../src/updater");
  const update = {
    version: "0.3.0",
    currentVersion: "0.2.0",
    download: vi.fn().mockRejectedValue(new Error("invalid signature")),
    install: vi.fn(),
    close: vi.fn(),
  };
  const prepare = vi.fn();
  await expect(installUpdate(update, vi.fn(), prepare)).rejects.toThrow(
    "invalid signature",
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(update.install).not.toHaveBeenCalled();
});
