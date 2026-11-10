import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChatSessionBar } from "../src/ChatSessionBar";
afterEach(cleanup);
const sessions = [
  { id: "one", title: "所有権の質問", createdAt: 1, updatedAt: 1 },
  { id: "two", title: "新しい会話", createdAt: 2, updatedAt: 2 },
];
it("lets the reader select an existing session and request another conversation", async () => {
  const user = userEvent.setup(),
    select = vi.fn(),
    create = vi.fn().mockResolvedValue(undefined);
  render(
    <ChatSessionBar
      sessions={sessions}
      activeId="one"
      disabled={false}
      onSelect={select}
      onCreate={create}
      onError={vi.fn()}
    />,
  );
  expect(screen.getByRole("option", { name: "所有権の質問" })).toBeDefined();
  await user.selectOptions(screen.getByLabelText("会話セッション"), "two");
  expect(select).toHaveBeenCalledWith("two");
  await user.click(screen.getByRole("button", { name: "新しい会話を作成" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
});
it("reports a creation failure without hiding existing sessions", async () => {
  const error = vi.fn();
  render(
    <ChatSessionBar
      sessions={sessions}
      activeId="one"
      disabled={false}
      onSelect={vi.fn()}
      onCreate={vi.fn().mockRejectedValue(new Error("保存できません"))}
      onError={error}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "新しい会話を作成" }),
  );
  await waitFor(() => expect(error).toHaveBeenCalledOnce());
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
    false,
  );
});
