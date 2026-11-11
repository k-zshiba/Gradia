import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Document, DocumentDeletion, Project } from "../src/types";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  settings: vi.fn(),
  projects: vi.fn(),
  translations: vi.fn(),
  sessions: vi.fn(),
  history: vi.fn(),
  events: vi.fn(),
  cancel: vi.fn(),
  preference: vi.fn(),
  deleteDocument: vi.fn(),
}));
vi.mock("../src/api", () => ({ desktop: true, api }));
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

let documents: Document[];
let projects: Project[];
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
  documents = [
    {
      ...previewDocument,
      id: "first",
      revision: "v1",
      title: "First",
      source: "C:/books/first.txt",
    },
    {
      ...previewDocument,
      id: "second",
      revision: "v2",
      title: "Second",
      source: "C:/books/second.txt",
    },
    {
      ...previewDocument,
      id: "third",
      revision: "v1",
      title: "Third",
      source: "C:/other/third.txt",
    },
  ];
  projects = [
    { id: "books", name: "Books", documentKeys: ["first:v1", "second:v2"] },
  ];
  api.list.mockImplementation(async () => documents);
  api.projects.mockImplementation(async () => projects);
  api.settings.mockResolvedValue({
    llamaPath: "",
    modelPath: "",
    gpuLayers: 0,
    codexPath: "",
    codexModel: "",
  });
  api.translations.mockResolvedValue({});
  api.sessions.mockResolvedValue([
    { id: "chat", title: "会話", createdAt: 1, updatedAt: 1 },
  ]);
  api.history.mockResolvedValue([]);
  api.events.mockResolvedValue(() => {});
  api.cancel.mockResolvedValue(undefined);
  api.preference.mockResolvedValue(undefined);
  api.deleteDocument.mockImplementation(
    async (id: string, revision: string) => {
      documents = documents.filter(
        (d) => d.id !== id || d.revision !== revision,
      );
      projects = projects.map((p) => ({
        ...p,
        documentKeys: p.documentKeys.filter((k) => k !== `${id}:${revision}`),
      }));
      return { deleted: [{ id, revision }], cleanupErrors: [] };
    },
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function start() {
  const user = userEvent.setup();
  const { container } = render(<App />);
  await user.click(await screen.findByRole("button", { name: "選択して削除" }));
  return { user, container };
}

it("selects documents without changing the reader and deletes nothing when confirmation is cancelled", async () => {
  const { user, container } = await start();
  const breadcrumb = container.querySelector(".breadcrumb");
  expect(breadcrumb?.textContent).toContain("First");
  await user.click(
    screen.getByRole("checkbox", { name: "Second（版 v2）を選択" }),
  );
  expect(breadcrumb?.textContent).toContain("First");
  await user.click(
    screen.getByRole("button", { name: "選択した資料を削除（1件）" }),
  );
  const dialog = screen.getByRole("dialog", { name: "選択した資料を削除" });
  expect(within(dialog).getByText("Second")).toBeDefined();
  expect(within(dialog).queryByText("First")).toBeNull();
  expect(within(dialog).getByText(/この版だけを削除/)).toBeDefined();
  expect(api.deleteDocument).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "キャンセル" }));
  expect(api.deleteDocument).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "選択を終了" }));
  expect(screen.queryByRole("checkbox", { name: /を選択/ })).toBeNull();
});

it("selects only the filtered project documents and clears selection when search or project changes", async () => {
  const { user } = await start();
  await user.click(
    screen.getByRole("checkbox", { name: "First（版 v1）を選択" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "資料を探す" }),
    "Second",
  );
  expect(
    screen.getByRole("button", { name: "選択した資料を削除（0件）" }),
  ).toHaveProperty("disabled", true);
  await user.click(
    screen.getByRole("button", { name: "表示中の資料をすべて選択" }),
  );
  expect(
    screen.getByRole("checkbox", { name: "Second（版 v2）を選択" }),
  ).toHaveProperty("checked", true);
  await user.selectOptions(screen.getByLabelText("プロジェクト"), "books");
  expect(
    screen.getByRole("button", { name: "選択した資料を削除（0件）" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.queryByRole("checkbox", { name: "Third（版 v1）を選択" }),
  ).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "表示中の資料をすべて選択" }),
  );
  await user.click(
    screen.getByRole("button", { name: "選択した資料を削除（2件）" }),
  );
  await user.click(screen.getByRole("button", { name: "削除する" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.deleteDocument.mock.calls).toEqual([
    ["first", "v1", false],
    ["second", "v2", false],
  ]);
  expect(projects[0].documentKeys).toEqual([]);
  await user.selectOptions(screen.getByLabelText("プロジェクト"), "");
  expect(
    screen.getByRole("checkbox", { name: "Third（版 v1）を選択" }),
  ).toBeDefined();
});

it("refreshes successful removals, moves the reader to a remaining document, and retries only failed targets", async () => {
  const { user, container } = await start();
  const remove = api.deleteDocument.getMockImplementation()!;
  api.deleteDocument
    .mockImplementationOnce(remove)
    .mockRejectedValueOnce(new Error("使用中"));
  await user.click(
    screen.getByRole("checkbox", { name: "First（版 v1）を選択" }),
  );
  await user.click(
    screen.getByRole("checkbox", { name: "Second（版 v2）を選択" }),
  );
  await user.click(
    screen.getByRole("button", { name: "選択した資料を削除（2件）" }),
  );
  await user.click(screen.getByRole("button", { name: "削除する" }));
  await screen.findByText(/1件を削除できませんでした/);
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Second")).toBeDefined();
  expect(within(dialog).queryByText("First")).toBeNull();
  expect(
    screen.queryByRole("checkbox", { name: "First（版 v1）を選択" }),
  ).toBeNull();
  expect(container.querySelector(".breadcrumb")?.textContent).toContain(
    "Second",
  );
  await user.click(within(dialog).getByRole("button", { name: "削除する" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.deleteDocument.mock.calls).toEqual([
    ["first", "v1", false],
    ["second", "v2", false],
    ["second", "v2", false],
  ]);
  expect(container.querySelector(".breadcrumb")?.textContent).toContain(
    "Third",
  );
});

it("keeps deletion sequential and disables changes until all requests finish", async () => {
  const { user } = await start();
  let finish!: (result: DocumentDeletion) => void;
  api.deleteDocument.mockImplementationOnce(
    () =>
      new Promise<DocumentDeletion>((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(
    screen.getByRole("button", { name: "表示中の資料をすべて選択" }),
  );
  await user.click(
    screen.getByRole("button", { name: "選択した資料を削除（3件）" }),
  );
  await user.click(screen.getByRole("button", { name: "削除する" }));
  expect(api.deleteDocument).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "資料を追加" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("textbox", { name: "資料を探す" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("button", { name: "キャンセル" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(
    screen.getByRole("button", { name: "削除しています…" }),
  ).toHaveProperty("disabled", true);
  documents = documents.filter((d) => d.id !== "first");
  await act(async () =>
    finish({ deleted: [{ id: "first", revision: "v1" }], cleanupErrors: [] }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.deleteDocument).toHaveBeenCalledTimes(3);
});

it("retains successful removals when refreshing the library fails", async () => {
  const { user, container } = await start();
  api.list.mockRejectedValueOnce(new Error("一覧を取得できません"));
  await user.click(
    screen.getByRole("checkbox", { name: "First（版 v1）を選択" }),
  );
  await user.click(
    screen.getByRole("button", { name: "選択した資料を削除（1件）" }),
  );
  await user.click(screen.getByRole("button", { name: "削除する" }));
  await screen.findByText(/一覧の更新に失敗しました/);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    screen.queryByRole("checkbox", { name: "First（版 v1）を選択" }),
  ).toBeNull();
  expect(container.querySelector(".breadcrumb")?.textContent).toContain(
    "Second",
  );
  expect(
    screen.getByRole("button", { name: "選択した資料を削除（0件）" }),
  ).toHaveProperty("disabled", true);
});

it("keeps the frontend-only sample open and reports copy cleanup errors after deleting a document", async () => {
  const { user, container } = await start();
  await user.click(container.querySelector(".brand")!);
  await user.click(screen.getByRole("button", { name: "サンプルを開く" }));
  const remove = api.deleteDocument.getMockImplementation()!;
  api.deleteDocument.mockImplementationOnce(async (id, revision) => ({
    ...(await remove(id, revision)),
    cleanupErrors: ["保存コピーを削除できません"],
  }));
  expect(screen.getAllByRole("checkbox", { name: /を選択/ })).toHaveLength(3);
  await user.click(
    screen.getByRole("checkbox", { name: "First（版 v1）を選択" }),
  );
  await user.click(
    screen.getByRole("button", { name: "選択した資料を削除（1件）" }),
  );
  await user.click(screen.getByRole("button", { name: "削除する" }));
  await screen.findByText(/保存コピーの一部を削除できませんでした/);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    screen.queryByRole("checkbox", { name: "First（版 v1）を選択" }),
  ).toBeNull();
  expect(container.querySelector(".breadcrumb")?.textContent ?? "").toContain(
    "Understanding ownership",
  );
});
