// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import { QuickPromptEditor } from "./QuickPromptEditor";

const createQuickPrompt = vi.fn();
const updateQuickPrompt = vi.fn();
const deleteQuickPrompt = vi.fn();
const moveQuickPrompt = vi.fn();
vi.mock("../../api", () => ({
  createQuickPrompt: (i: unknown) => createQuickPrompt(i),
  updateQuickPrompt: (id: string, i: unknown) => updateQuickPrompt(id, i),
  deleteQuickPrompt: (id: string) => deleteQuickPrompt(id),
  moveQuickPrompt: (id: string, d: string) => moveQuickPrompt(id, d),
}));

const prompts = [{ id: "p1", label: "テスト", text: "run tests" }];

beforeEach(() => {
  createQuickPrompt.mockReset().mockResolvedValue({});
  updateQuickPrompt.mockReset().mockResolvedValue({});
  deleteQuickPrompt.mockReset().mockResolvedValue({ removed: true });
  moveQuickPrompt.mockReset().mockResolvedValue({ moved: true });
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
  it("K2 disables up on the first row and down on the last row; K1 calls move for the others", async () => {
    const onChanged = vi.fn();
    const three = [
      { id: "p1", label: "一", text: "1" },
      { id: "p2", label: "二", text: "2" },
      { id: "p3", label: "三", text: "3" },
    ];
    render(<QuickPromptEditor prompts={three} onChanged={onChanged} />);
    const ups = screen.getAllByRole("button", { name: "上へ" }) as HTMLButtonElement[];
    const downs = screen.getAllByRole("button", { name: "下へ" }) as HTMLButtonElement[];
    expect(ups.map((b) => b.disabled)).toEqual([true, false, false]);
    expect(downs.map((b) => b.disabled)).toEqual([false, false, true]);
    fireEvent.click(ups[1]);
    await waitFor(() => expect(moveQuickPrompt).toHaveBeenCalledWith("p2", "up"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    fireEvent.click(downs[0]);
    await waitFor(() => expect(moveQuickPrompt).toHaveBeenCalledWith("p1", "down"));
  });

  it("K4 renders rows in the order given by the props", () => {
    const { rerender } = render(
      <QuickPromptEditor prompts={[{ id: "p1", label: "一", text: "1" }, { id: "p2", label: "二", text: "2" }]} onChanged={() => {}} />,
    );
    const order = (): string[] => screen.getAllByTestId("quick-prompt-item").map((n) => n.querySelector(".ac-quick-editor__label")?.textContent ?? "");
    expect(order()).toEqual(["一", "二"]);
    rerender(<QuickPromptEditor prompts={[{ id: "p2", label: "二", text: "2" }, { id: "p1", label: "一", text: "1" }]} onChanged={() => {}} />);
    expect(order()).toEqual(["二", "一"]);
  });
});
