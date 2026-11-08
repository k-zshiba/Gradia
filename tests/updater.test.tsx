import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { UpdateControl } from "../src/UpdateControl";
const mocks = vi.hoisted(() => ({
  startup: vi.fn(),
  check: vi.fn(),
  install: vi.fn(),
}));
vi.mock("../src/api", () => ({ desktop: true }));
vi.mock("../src/updater", () => ({
  checkAtStartup: mocks.startup,
  checkForUpdate: mocks.check,
  installUpdate: mocks.install,
}));
const candidate = () => ({
  version: "0.3.0",
  currentVersion: "0.2.0",
  body: "New version",
  close: vi.fn().mockResolvedValue(undefined),
  download: vi.fn(),
  install: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);
describe("update consent", () => {
  it("shows the available version but never installs before Yes", async () => {
    const update = candidate();
    mocks.startup.mockResolvedValue(update);
    render(
      <StrictMode>
        <UpdateControl beforeInstall={vi.fn()} />
      </StrictMode>,
    );
    expect(await screen.findByText("0.3.0")).toBeTruthy();
    expect(mocks.install).not.toHaveBeenCalled();
    await userEvent.click(
      await screen.findByRole("button", { name: "今は更新しない" }),
    );
    expect(update.close).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("installs only after Yes and prepares shutdown before installation", async () => {
    const update = candidate(),
      prepare = vi.fn().mockResolvedValue(undefined);
    mocks.startup.mockResolvedValue(update);
    mocks.install.mockImplementation(async (_u, _p, before) => before());
    render(<UpdateControl beforeInstall={prepare} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "はい、更新する" }),
    );
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(mocks.install).toHaveBeenCalledOnce();
  });
  it("keeps the app usable if download or signature validation fails", async () => {
    mocks.startup.mockResolvedValue(candidate());
    mocks.install.mockRejectedValue(new Error("signature verification failed"));
    const prepare = vi.fn();
    render(<UpdateControl beforeInstall={prepare} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "はい、更新する" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "現在のバージョンで引き続き",
    );
    expect(prepare).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "今は更新しない" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("silently tolerates offline startup and reports manual check failures", async () => {
    mocks.startup.mockRejectedValue(new Error("offline"));
    mocks.check.mockRejectedValue(new Error("offline"));
    render(<UpdateControl beforeInstall={vi.fn()} />);
    await waitFor(() => expect(mocks.startup).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "更新を確認" }));
    expect(await screen.findByText(/更新を確認できませんでした/)).toBeTruthy();
  });
  it("Escape dismisses an available update without installing", async () => {
    const update = candidate();
    mocks.startup.mockResolvedValue(update);
    render(<UpdateControl beforeInstall={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(update.close).toHaveBeenCalledOnce());
    expect(mocks.install).not.toHaveBeenCalled();
  });
});
