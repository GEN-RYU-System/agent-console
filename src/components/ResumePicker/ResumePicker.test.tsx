// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { ResumeTarget } from "../../types";
import { ResumePicker } from "./ResumePicker";

const items: ResumeTarget[] = [
  { kind: "main", path: "/repo", branch: "main", roleId: "opus-designer" },
  { kind: "worktree", path: "/wt/release-alpha", branch: "release/alpha", roleId: "sonnet-impl" },
  { kind: "worktree", path: "/wt/release-beta", branch: "release/beta", roleId: "sonnet-impl" },
  { kind: "worktree", path: "/wt/detached", branch: null, roleId: "sonnet-impl" },
];
const base = { items, busyPath: null, error: null, onResume: () => {} };

describe("ResumePicker", () => {
  it("K1: shows one Opus row for the main checkout and one Sonnet row per worktree labelled with the branch", () => {
    render(<ResumePicker {...base} />);
    const rows = screen.getAllByTestId("resume-target");
    expect(rows.map((r) => [r.getAttribute("data-kind"), r.getAttribute("data-path")])).toEqual([
      ["main", "/repo"],
      ["worktree", "/wt/release-alpha"],
      ["worktree", "/wt/release-beta"],
      ["worktree", "/wt/detached"],
    ]);
    expect(screen.getByText("Opus 設計役（本店）")).toBeTruthy();
    expect(screen.getByText("Sonnet 実装役（release/alpha）")).toBeTruthy();
    expect(screen.getByText("Sonnet 実装役（detached）")).toBeTruthy();
  });

  it("K1: filters worktrees by name (case-insensitive) and keeps the main row", () => {
    render(<ResumePicker {...base} />);
    fireEvent.change(screen.getByLabelText("worktree を名前で絞り込む"), { target: { value: "BETA" } });
    expect(screen.getAllByTestId("resume-target").map((r) => r.getAttribute("data-path"))).toEqual(["/repo", "/wt/release-beta"]);
    fireEvent.change(screen.getByLabelText("worktree を名前で絞り込む"), { target: { value: "zzz" } });
    expect(screen.getAllByTestId("resume-target").map((r) => r.getAttribute("data-path"))).toEqual(["/repo"]);
    expect(screen.getByText("条件に合う worktree がありません")).toBeTruthy();
  });

  it("passes the chosen row (kind and path only) to onResume", () => {
    const onResume = vi.fn();
    render(<ResumePicker {...base} onResume={onResume} />);
    fireEvent.click(screen.getAllByRole("button", { name: "再開" })[1]);
    expect(onResume).toHaveBeenCalledWith(items[1]);
  });

  it("K6: shows the guide (Ctrl+W / Ctrl+A meaning, do not pick a running conversation)", () => {
    render(<ResumePicker {...base} />);
    const guide = screen.getByTestId("resume-guide").textContent ?? "";
    expect(guide).toContain("Ctrl+W");
    expect(guide).toContain("Ctrl+A");
    expect(guide).toContain("今動いている会話は選ばない");
  });

  it("shows loading, empty and error states", () => {
    const { rerender } = render(<ResumePicker {...base} items={null} />);
    expect(screen.getByText("読み込み中")).toBeTruthy();
    rerender(<ResumePicker {...base} items={[]} />);
    expect(screen.getByText("再開できる場所がありません")).toBeTruthy();
    rerender(<ResumePicker {...base} error="resume target is outside" />);
    expect(screen.getByRole("alert").textContent).toContain("resume target is outside");
  });
});
