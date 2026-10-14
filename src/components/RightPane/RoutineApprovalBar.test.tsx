// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n";

const fetchRoutineApproval = vi.fn();
const issueRoutineApproval = vi.fn();
vi.mock("../../api", () => ({ fetchRoutineApproval: (...a: unknown[]) => fetchRoutineApproval(...a), issueRoutineApproval: (...a: unknown[]) => issueRoutineApproval(...a) }));

const { RoutineApprovalBar } = await import("./RoutineApprovalBar");

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ルーティン承認ボタン", () => {
  it("承認が無いときはボタンが出て、押すと「承認中（残り n 分・未使用）」に変わる", async () => {
    fetchRoutineApproval.mockResolvedValue({ approval: null });
    issueRoutineApproval.mockResolvedValue({ approved: true, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    render(<RoutineApprovalBar sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "ルーティンの変更を 1 回承認する" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("承認中（残り 30 分・未使用）"));
    expect(issueRoutineApproval).toHaveBeenCalledWith("s1");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("すでに承認中なら、最初から残り時間を出す", async () => {
    fetchRoutineApproval.mockResolvedValue({ approval: { by: "ui", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } });
    render(<RoutineApprovalBar sessionId="s1" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("承認中（残り 5 分・未使用）"));
  });

  it("承認に失敗したら注意書きを出す", async () => {
    fetchRoutineApproval.mockResolvedValue({ approval: null });
    issueRoutineApproval.mockRejectedValue(new Error("x"));
    render(<RoutineApprovalBar sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "ルーティンの変更を 1 回承認する" }));
    await waitFor(() => expect(screen.getByText("承認できませんでした。セッションが開始済みか確認してください。")).toBeTruthy());
  });
});
