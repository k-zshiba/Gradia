import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobEvent } from "../src/types";
const mock = vi.hoisted(() => ({
  api: {
    list: vi.fn(),
    settings: vi.fn(),
    projects: vi.fn(),
    translations: vi.fn(),
    sessions: vi.fn(),
    history: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    events: vi.fn(),
    cancel: vi.fn(),
    chat: vi.fn(),
    preference: vi.fn(),
  },
  event: (_e: JobEvent) => {},
}));
vi.mock("../src/api", () => ({ desktop: true, api: mock.api }));
vi.mock("../src/UpdateControl", () => ({ UpdateControl: () => null }));
vi.mock("../src/library", () => ({ importLocalFiles: vi.fn() }));
vi.mock("../src/importers", () => ({ extractWeb: vi.fn() }));
vi.mock("../src/components", () => ({
  CodeViewer: () => null,
  PdfOriginal: () => null,
  SettingsDialog: () => null,
  InlineText: ({ text }: { text: string }) => <span>{text}</span>,
}));
import App from "../src/App";
import { previewDocument } from "../src/preview";
const sessions = [
  { id: "one", title: "会話1", createdAt: 1, updatedAt: 1 },
  { id: "two", title: "会話2", createdAt: 2, updatedAt: 2 },
];
beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mock.api.list.mockResolvedValue([{ ...previewDocument, id: "book" }]);
  mock.api.settings.mockResolvedValue({
    llamaPath: "",
    modelPath: "",
    gpuLayers: 0,
    codexPath: "",
    codexModel: "",
  });
  mock.api.projects.mockResolvedValue([]);
  mock.api.translations.mockResolvedValue({});
  mock.api.sessions.mockResolvedValue(sessions);
  mock.api.history.mockImplementation(async (_id, _rev, session) => [
    {
      id: "message-" + session,
      role: "user",
      text: session === "one" ? "最初の履歴" : "別の履歴",
      status: "completed",
      references: [],
      createdAt: 1,
    },
  ]);
  mock.api.events.mockImplementation(async (handler) => {
    mock.event = handler;
    return () => {};
  });
  mock.api.cancel.mockResolvedValue(undefined);
  mock.api.preference.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("keeps late stream events out of another session and sends the selected session ID", async () => {
  const user = userEvent.setup();
  mock.api.chat.mockResolvedValue("answer-one");
  render(<App />);
  await screen.findByText("最初の履歴");
  await user.type(screen.getByRole("textbox", { name: "質問" }), "説明して");
  await user.click(screen.getByRole("button", { name: "質問を送信" }));
  expect(mock.api.chat.mock.calls[0][4]).toBe("one");
  await user.selectOptions(screen.getByLabelText("会話セッション"), "two");
  await screen.findByText("別の履歴");
  expect(mock.api.cancel).toHaveBeenCalledWith("answer-one");
  act(() =>
    mock.event({
      kind: "chat",
      jobId: "answer-one",
      documentId: "book",
      messageId: "answer-one",
      text: "前の会話の遅い回答",
      status: "completed",
    }),
  );
  expect(screen.queryByText("前の会話の遅い回答")).toBeNull();
  expect(screen.getByText("別の履歴")).toBeDefined();
});

it("cancels a late start without clearing the new session's running answer", async () => {
  const user = userEvent.setup();
  let finish!: (job: string) => void;
  mock.api.chat
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce("answer-two");
  render(<App />);
  await screen.findByText("最初の履歴");
  await user.type(screen.getByRole("textbox", { name: "質問" }), "最初の質問");
  await user.click(screen.getByRole("button", { name: "質問を送信" }));
  await user.selectOptions(screen.getByLabelText("会話セッション"), "two");
  await screen.findByText("別の履歴");
  await user.type(screen.getByRole("textbox", { name: "質問" }), "次の質問");
  await user.click(screen.getByRole("button", { name: "質問を送信" }));
  await act(async () => finish("answer-one"));
  await waitFor(() =>
    expect(mock.api.cancel).toHaveBeenCalledWith("answer-one"),
  );
  await user.click(screen.getByRole("button", { name: "回答を中断" }));
  expect(mock.api.cancel).toHaveBeenLastCalledWith("answer-two");
});

it("selects a remaining conversation after deletion and permits a fresh start after deleting the last", async () => {
  const user = userEvent.setup();
  let remaining = [...sessions];
  mock.api.sessions.mockImplementation(async () => remaining);
  mock.api.deleteSession.mockImplementation(async (_id, _rev, sessionId) => {
    remaining = remaining.filter((s) => s.id !== sessionId);
  });
  mock.api.createSession.mockImplementation(async () => {
    const created = {
      id: "three",
      title: "新しい会話",
      createdAt: 3,
      updatedAt: 3,
    };
    remaining = [created];
    return created;
  });
  render(<App />);
  await screen.findByText("最初の履歴");
  for (const id of ["one", "two"]) {
    await user.click(screen.getByRole("button", { name: "会話を削除" }));
    await user.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mock.api.deleteSession).toHaveBeenLastCalledWith(
      "book",
      "preview",
      id,
    );
    if (id === "one") await screen.findByText("別の履歴");
  }
  expect(screen.queryByText("最初の履歴")).toBeNull();
  expect(screen.queryByText("別の履歴")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "質問を送信" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "新しい会話を作成" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("会話セッション") as HTMLSelectElement).value,
    ).toBe("three"),
  );
});
