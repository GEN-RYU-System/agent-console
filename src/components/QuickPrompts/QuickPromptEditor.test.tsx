// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { QuickPromptEditor } from "./QuickPromptEditor";

const createQuickPrompt = vi.fn();
const updateQuickPrompt = vi.fn();
const deleteQuickPrompt = vi.fn();
vi.mock("../../api", () => ({
  createQuickPrompt: (i: unknown) => createQuickPrompt(i),
  updateQuickPrompt: (id: string, i: unknown) => updateQuickPrompt(id, i),
  deleteQuickPrompt: (id: string) => deleteQuickPrompt(id),
}));

const prompts = [{ id: "p1", label: "テスト", text: "run tests" }];

beforeEach(() => {
  createQuickPrompt.mockReset().mockResolvedValue({});
  updateQuickPrompt.mockReset().mockResolvedValue({});
  deleteQuickPrompt.mockReset().mockResolvedValue({ removed: true });
});

describe("QuickPromptEditor", () => {
  it("adds a prompt and asks for a reload", async () => {
    const onChanged = vi.fn();
    render(<QuickPromptEditor prompts={[]} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText(/ボタンの名前/), { target: { value: "新規" } });
    fireEvent.change(screen.getByLabelText(/送る文章/), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(createQuickPrompt).toHaveBeenCalledWith({ label: "新規", text: "hello" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("edits an existing prompt through update, not create", async () => {
    render(<QuickPromptEditor prompts={prompts} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    expect((screen.getByLabelText(/ボタンの名前/) as HTMLInputElement).value).toBe("テスト");
    fireEvent.change(screen.getByLabelText(/送る文章/), { target: { value: "run lint" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateQuickPrompt).toHaveBeenCalledWith("p1", { label: "テスト", text: "run lint" }));
    expect(createQuickPrompt).not.toHaveBeenCalled();
  });

  it("deletes a prompt", async () => {
    render(<QuickPromptEditor prompts={prompts} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    await waitFor(() => expect(deleteQuickPrompt).toHaveBeenCalledWith("p1"));
  });

  it("shows the server's error and keeps the input", async () => {
    createQuickPrompt.mockRejectedValue(new Error("text must be at most 8KB"));
    render(<QuickPromptEditor prompts={[]} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText(/ボタンの名前/), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/送る文章/), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    expect((await screen.findByRole("alert")).textContent).toContain("8KB");
    expect((screen.getByLabelText(/送る文章/) as HTMLTextAreaElement).value).toBe("y");
  });
});
