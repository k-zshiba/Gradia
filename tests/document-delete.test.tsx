import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
const remove = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: { deleteDocument: remove } }));
import { DocumentDeleteButton } from "../src/DocumentDeleteButton";
import { previewDocument } from "../src/preview";
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keeps the original document until the user confirms the selected deletion scope", async () => {
  const user = userEvent.setup();
  const deleted = vi.fn().mockResolvedValue(undefined),
    error = vi.fn();
  remove.mockResolvedValue({ deleted: [], cleanupErrors: [] });
  render(
    <DocumentDeleteButton
      document={previewDocument}
      disabled={false}
      onDeleted={deleted}
      onError={error}
    />,
  );
  await user.click(screen.getByRole("button", { name: "資料を削除" }));
  expect(
    screen.getByText(/元のファイルやWebページは変更しません/),
  ).toBeDefined();
  await user.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "資料を削除" }));
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "削除する" }));
  expect(remove).toHaveBeenCalledWith("sample", "preview", true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(deleted).toHaveBeenCalledOnce();
});

it("defaults to the current version and keeps the dialog available on failure", async () => {
  const user = userEvent.setup(),
    error = vi.fn();
  remove.mockRejectedValue(new Error("処理が終了していません"));
  render(
    <DocumentDeleteButton
      document={previewDocument}
      disabled={false}
      onDeleted={vi.fn()}
      onError={error}
    />,
  );
  await user.click(screen.getByRole("button", { name: "資料を削除" }));
  await user.click(screen.getByRole("button", { name: "削除する" }));
  await waitFor(() => expect(error).toHaveBeenCalled());
  expect(remove).toHaveBeenCalledWith("sample", "preview", false);
  expect(screen.getByRole("dialog")).toBeDefined();
});
