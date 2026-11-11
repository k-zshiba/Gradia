import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserWorkspace } from "../src/BrowserWorkspace";

const native = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  action: vi.fn(),
  status: vi.fn(),
  display: vi.fn(),
  capture: vi.fn(),
  translate: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../src/browser", () => ({
  browserApi: native,
  browserBounds: () => ({ x: 0, y: 200, width: 1000, height: 500 }),
}));
vi.mock("../src/api", () => ({ api: { cancel: vi.fn() } }));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  native.open.mockResolvedValue(undefined);
  native.close.mockResolvedValue(undefined);
  native.action.mockResolvedValue(undefined);
  native.status.mockResolvedValue({
    status: {
      generation: 1,
      url: "https://example.org/",
      title: "Page",
      loading: true,
      canGoBack: false,
      canGoForward: false,
      error: null,
    },
    snapshot: null,
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("closes the native pane before opening settings", async () => {
  const settings = vi.fn();
  let closed: (() => void) | undefined;
  native.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        closed = resolve;
      }),
  );
  render(
    <BrowserWorkspace
      url="https://example.org/"
      projects={[]}
      projectId=""
      onReturn={vi.fn()}
      onSaved={vi.fn()}
      onSettings={settings}
    />,
  );
  await waitFor(() => expect(native.action).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "設定" }));
  expect(settings).not.toHaveBeenCalled();
  closed?.();
  await waitFor(() => expect(settings).toHaveBeenCalledOnce());
});

it("keeps return and settings usable when native creation fails", async () => {
  native.open.mockRejectedValue(new Error("Web表示を準備できません"));
  const back = vi.fn();
  render(
    <BrowserWorkspace
      url="https://example.org/"
      projects={[]}
      projectId=""
      onReturn={back}
      onSaved={vi.fn()}
      onSettings={vi.fn()}
    />,
  );
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "資料に戻る" }));
  await waitFor(() => expect(back).toHaveBeenCalledOnce());
});

it("keeps return usable when the reader refresh fails after the original was saved", async () => {
  const saved = { id: "saved", revision: "original-v1" };
  const onSaved = vi
    .fn()
    .mockRejectedValue(new Error("資料一覧を再取得できません"));
  const onReturn = vi.fn();
  native.status.mockResolvedValue({
    status: {
      generation: 1,
      url: "https://example.org/",
      title: "Page",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    },
    snapshot: {
      id: "snapshot",
      sessionId: "session",
      generation: 1,
      url: "https://example.org/",
      title: "Page",
      segments: [],
      translations: {},
      truncated: false,
      jobId: null,
      error: null,
    },
  });
  native.display.mockResolvedValue({ written: 0, skipped: 0 });
  native.save.mockResolvedValue(saved);
  render(
    <BrowserWorkspace
      url="https://example.org/"
      projects={[]}
      projectId=""
      onReturn={onReturn}
      onSaved={onSaved}
      onSettings={vi.fn()}
    />,
  );
  await waitFor(() => expect(native.display).toHaveBeenCalled());
  await userEvent.click(
    screen.getByRole("button", { name: "原文を保存してAIに質問" }),
  );
  await screen.findByRole("alert");
  expect(onSaved).toHaveBeenCalledWith(saved);
  await userEvent.click(screen.getByRole("button", { name: "資料に戻る" }));
  await waitFor(() => expect(onReturn).toHaveBeenCalledOnce());
});

it("uses distinct sessions across StrictMode setup and settles the abandoned opening", async () => {
  const openings: (() => void)[] = [];
  native.open.mockImplementation(
    () => new Promise<void>((resolve) => openings.push(resolve)),
  );
  render(
    <StrictMode>
      <BrowserWorkspace
        url="https://example.org/"
        projects={[]}
        projectId=""
        onReturn={vi.fn()}
        onSaved={vi.fn()}
        onSettings={vi.fn()}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(native.open).toHaveBeenCalledTimes(2));
  const first = native.open.mock.calls[0][0],
    second = native.open.mock.calls[1][0];
  expect(first).not.toBe(second);
  expect(native.close).toHaveBeenCalledWith(first);
  openings[0]();
  openings[1]();
  await waitFor(() =>
    expect(native.close.mock.calls.filter(([id]) => id === first)).toHaveLength(
      2,
    ),
  );
  expect(native.close).not.toHaveBeenCalledWith(second);
});
