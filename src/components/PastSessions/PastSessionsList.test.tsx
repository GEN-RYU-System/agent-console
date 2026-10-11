// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { PastSession } from "../../types";
import { PastSessionsList } from "./PastSessionsList";

const items: PastSession[] = [
  { sessionId: "11111111-1111-4111-8111-111111111111", name: "old work", cwd: "/repo", startedAt: 1700000000000, status: "idle", blocked: null },
  { sessionId: "22222222-2222-4222-8222-222222222222", name: "running", cwd: "/repo", startedAt: null, status: "busy", blocked: "running" },
];

const base = { items, available: true, canResume: true, busyId: null, error: null, onResume: () => {} };

describe("PastSessionsList", () => {
  it("resumes the chosen session by id", () => {
    const onResume = vi.fn();
    render(<PastSessionsList {...base} onResume={onResume} />);
    const buttons = screen.getAllByRole("button", { name: "再開" });
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[0]);
    expect(onResume).toHaveBeenCalledWith(items[0].sessionId);
    expect(screen.getByTestId("past-blocked").textContent).toContain("今動いています");
  });

  it("disables resuming when no role can resume and says why", () => {
    render(<PastSessionsList {...base} canResume={false} />);
    for (const b of screen.getAllByRole("button", { name: "再開" })) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("再開できる役割がありません")).toBeTruthy();
  });

  it("shows loading, empty and unavailable states", () => {
    const { rerender } = render(<PastSessionsList {...base} items={null} />);
    expect(screen.getByText("読み込み中")).toBeTruthy();
    rerender(<PastSessionsList {...base} items={[]} />);
    expect(screen.getByText("過去のセッションがありません")).toBeTruthy();
    rerender(<PastSessionsList {...base} items={[]} available={false} />);
    expect(screen.getByText("一覧を取得できません")).toBeTruthy();
  });

  it("shows a resume error", () => {
    render(<PastSessionsList {...base} error="working directory does not exist" />);
    expect(screen.getByRole("alert").textContent).toContain("working directory does not exist");
  });

  it("says why a row cannot be resumed (main checkout / outside / missing) and disables it", () => {
    const rows: PastSession[] = (["main", "outside", "missing"] as const).map((blocked, i) => ({
      sessionId: `0000000${i}-0000-4000-8000-000000000000`,
      name: blocked,
      cwd: "/x",
      startedAt: 1,
      status: "idle",
      blocked,
    }));
    render(<PastSessionsList {...base} items={rows} />);
    const reasons = screen.getAllByTestId("past-blocked");
    expect(reasons.map((r) => r.getAttribute("data-reason"))).toEqual(["main", "outside", "missing"]);
    expect(reasons[0].textContent).toContain("Opus 設計役");
    for (const b of screen.getAllByRole("button", { name: "再開" })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});
