import { beforeEach, expect, it, vi } from "vitest";
import type { Document } from "../src/types";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  importFile: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: { read: mocks.read, save: mocks.save } }));
vi.mock("../src/importers", () => ({ importFile: mocks.importFile }));
import { importLocalFiles } from "../src/library";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockImplementation(async (path) => ({
    path,
    content: "Original text.",
  }));
  mocks.importFile.mockImplementation(async (file) => ({
    source: file.path,
    content: file.content,
  }));
  mocks.save.mockImplementation(
    async (doc) => ({ ...doc, id: doc.source, revision: "v1" }) as Document,
  );
});

it("adds every selected file once to the chosen project and reports progress", async () => {
  const progress = vi.fn();
  const result = await importLocalFiles(
    ["a.md", "b.pdf", "a.md"],
    "rust",
    progress,
    new AbortController().signal,
  );
  expect(result.documents.map((d) => d.source)).toEqual(["a.md", "b.pdf"]);
  expect(mocks.save.mock.calls.map((args) => args[1])).toEqual([
    "rust",
    "rust",
  ]);
  expect(progress).toHaveBeenCalledWith("資料を取り込んでいます 2 / 2 · b.pdf");
  expect(result.failures).toEqual([]);
  expect(result.cancelled).toBe(false);
});

it("keeps successful files and reports read, extraction and save failures individually", async () => {
  mocks.read.mockImplementation(async (path) => {
    if (path === "broken.pdf") throw new Error("ファイルを読めません");
    return { path };
  });
  mocks.importFile.mockImplementation(async (file) => {
    if (file.path === "encrypted.pdf") throw new Error("パスワードが必要です");
    return { source: file.path };
  });
  mocks.save.mockImplementation(async (doc) => {
    if (doc.source === "unsaved.md") throw new Error("保存できません");
    return { ...doc, id: "ok", revision: "v1" };
  });
  const result = await importLocalFiles(
    ["broken.pdf", "encrypted.pdf", "unsaved.md", "good.md"],
    null,
    vi.fn(),
    new AbortController().signal,
  );
  expect(result.documents.map((d) => d.source)).toEqual(["good.md"]);
  expect(result.failures).toEqual([
    { path: "broken.pdf", error: "ファイルを読めません" },
    { path: "encrypted.pdf", error: "パスワードが必要です" },
    { path: "unsaved.md", error: "保存できません" },
  ]);
});

it("finishes saving the current file on cancellation and leaves later files untouched", async () => {
  const controller = new AbortController();
  mocks.importFile.mockImplementation(async (file) => {
    controller.abort();
    return { source: file.path };
  });
  const result = await importLocalFiles(
    ["first.md", "later.md"],
    "project",
    vi.fn(),
    controller.signal,
  );
  expect(result.documents.map((d) => d.source)).toEqual(["first.md"]);
  expect(result.cancelled).toBe(true);
  expect(mocks.read.mock.calls).toEqual([["first.md"]]);
});

it("imports Markdown image references only when files came from the selected folder", async () => {
  mocks.read.mockImplementation(async (path) => ({
    path,
    content:
      "![図](images/figure.png)\n\n![Ref][figure]\n\n[figure]: ../shared/diagram.jpg",
  }));
  await importLocalFiles(
    ["book.md", "code.rs"],
    null,
    vi.fn(),
    new AbortController().signal,
    true,
  );
  expect(mocks.read.mock.calls).toEqual([["book.md", true], ["code.rs"]]);
  expect(mocks.save.mock.calls[0][2]).toEqual([
    "images/figure.png",
    "../shared/diagram.jpg",
  ]);
  expect(mocks.save.mock.calls[1]).toHaveLength(2);
});
