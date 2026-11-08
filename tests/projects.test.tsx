import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectControls } from "../src/ProjectControls";
afterEach(cleanup);

function setup(active = "") {
  const props = {
    projects: [{ id: "rust", name: "Rust", documentKeys: ["book:v1"] }],
    active,
    disabled: false,
    onSelect: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
  render(<ProjectControls {...props} />);
  return { ...props, user: userEvent.setup() };
}

it("selects a project and creates one with a trimmed nonempty name", async () => {
  const { user, onSelect, onCreate } = setup();
  await user.selectOptions(screen.getByLabelText("プロジェクト"), "rust");
  expect(onSelect).toHaveBeenCalledWith("rust");
  await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
  expect(
    screen.getByRole("button", { name: "作成" }),
  ).toHaveProperty("disabled", true);
  await user.type(screen.getByLabelText("プロジェクト名"), " Books ");
  await user.click(screen.getByRole("button", { name: "作成" }));
  expect(onCreate).toHaveBeenCalledWith("Books");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("renames the selected project", async () => {
  const { user, onRename } = setup("rust");
  await user.click(screen.getByRole("button", { name: "プロジェクトを管理" }));
  await user.clear(screen.getByLabelText("プロジェクト名"));
  await user.type(screen.getByLabelText("プロジェクト名"), "Learning Rust");
  await user.click(screen.getByRole("button", { name: "名前を保存" }));
  expect(onRename).toHaveBeenCalledWith("rust", "Learning Rust");
});

it("requires a second action to delete and explains that documents are retained", async () => {
  const { user, onDelete } = setup("rust");
  await user.click(screen.getByRole("button", { name: "プロジェクトを管理" }));
  await user.click(screen.getByRole("button", { name: "プロジェクトを削除" }));
  expect(onDelete).not.toHaveBeenCalled();
  expect(
    screen.getByText(/資料・訳文・会話履歴は「すべての資料」に残ります/),
  ).toBeDefined();
  await user.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(onDelete).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "プロジェクトを削除" }));
  await user.click(
    screen.getByRole("button", { name: "削除する" }),
  );
  expect(onDelete).toHaveBeenCalledWith("rust");
});

it("keeps the entered name available when saving fails", async () => {
  const { user, onCreate, onError } = setup();
  onCreate.mockRejectedValue(
    new Error("同じ名前のプロジェクトがすでにあります"),
  );
  await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
  await user.type(screen.getByLabelText("プロジェクト名"), "Rust");
  await user.click(screen.getByRole("button", { name: "作成" }));
  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(screen.getByLabelText("プロジェクト名")).toHaveProperty(
    "value",
    "Rust",
  );
});
