// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { QuickPrompt } from "../../types";
import { QuickPromptBar } from "./QuickPromptBar";

const updateQuickPrompt = vi.fn();
vi.mock("../../api", () => ({
  updateQuickPrompt: (id: string, i: unknown) => updateQuickPrompt(id, i),
}));

const prompts: QuickPrompt[] = [
  { id: "p1", label: "テスト実行", text: "run tests", pinned: true },
  { id: "p2", label: "リント", text: "run lint", pinned: false },
  { id: "p3", label: "ビルド", text: "run build", pinned: true },
];

function renderBar(overrides: Partial<React.ComponentProps<typeof QuickPromptBar>> = {}) {
  const props = { prompts, canSend: true, onSend: vi.fn(), onEdit: vi.fn(), onChanged: vi.fn(), ...overrides };
  render(<QuickPromptBar {...props} />);
  return props;
}

beforeEach(() => {
  updateQuickPrompt.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe("QuickPromptBar (v0.10.0 K3)", () => {
  it("shows only the pinned prompts as buttons, in saved order, between the list button and the edit button", () => {
    renderBar();
    const bar = screen.getByTestId("quick-prompt-bar");
    expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["よく使う指示", "テスト実行", "ビルド", "指示を編集"]);
  });

  it("sends a pinned prompt from the bar", () => {
    const { onSend } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "ビルド" }));
    expect(onSend).toHaveBeenCalledWith("p3");
  });

  it("opens a dialog with every prompt (pinned or not) from the list button", () => {
    renderBar();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "よく使う指示" }));
    const dialog = screen.getByRole("dialog");
    const rows = within(dialog).getAllByTestId("quick-prompt-list-item");
    expect(rows.map((r) => within(r).getByTestId("quick-prompt-list-label").textContent)).toEqual(["テスト実行", "リント", "ビルド"]);
  });

  it("uses a prompt from the dialog like the bar button does, then closes the dialog", async () => {
    const { onSend } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "よく使う指示" }));
    const row = screen.getAllByTestId("quick-prompt-list-item")[1];
    fireEvent.click(within(row).getByRole("button", { name: "使う" }));
    expect(onSend).toHaveBeenCalledWith("p2");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("disables 使う in the dialog when the session cannot receive input", () => {
    renderBar({ canSend: false });
    fireEvent.click(screen.getByRole("button", { name: "よく使う指示" }));
    for (const row of screen.getAllByTestId("quick-prompt-list-item")) {
      expect((within(row).getByRole("button", { name: "使う" }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("shows pinned as aria-pressed and toggles it through update with pinned only, then asks for a reload", async () => {
    const { onChanged } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "よく使う指示" }));
    const rows = screen.getAllByTestId("quick-prompt-list-item");
    const first = within(rows[0]).getByRole("button", { name: "常に表示" });
    const second = within(rows[1]).getByRole("button", { name: "常に表示" });
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(first);
    await waitFor(() => expect(updateQuickPrompt).toHaveBeenCalledWith("p1", { pinned: false }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    fireEvent.click(second);
    await waitFor(() => expect(updateQuickPrompt).toHaveBeenCalledWith("p2", { pinned: true }));
  });

  it("closes the dialog with Esc", async () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "よく使う指示" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows an error when toggling fails", async () => {
    updateQuickPrompt.mockRejectedValue(new Error("boom"));
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "よく使う指示" }));
    fireEvent.click(within(screen.getAllByTestId("quick-prompt-list-item")[0]).getByRole("button", { name: "常に表示" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("boom"));
  });

  it("calls onEdit from the edit button", () => {
    const { onEdit } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "指示を編集" }));
    expect(onEdit).toHaveBeenCalled();
  });
});
