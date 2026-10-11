// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { RoleView, SessionView } from "../../types";
import { SessionList } from "./SessionList";

const roles: RoleView[] = [{ id: "shell", labelKey: "role.shell", needsWorktree: false }];
const sessions: SessionView[] = [
  { id: "a", name: "first", roleId: "shell", branch: null, cwd: "/", state: "working", createdAt: 1, unread: 0, hasClaude: true, canInput: false },
  { id: "b", name: "second", roleId: "shell", branch: null, cwd: "/", state: "stopped", createdAt: 2, unread: 2, hasClaude: false, canInput: false },
];

describe("SessionList", () => {
  it("renders name, role label and state for each session", () => {
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} />);
    expect(screen.getAllByTestId("session-row").length).toBe(2);
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getAllByText("シェル").length).toBe(2);
    expect(screen.getByText("作業中")).toBeTruthy();
    expect(screen.getByText("停止")).toBeTruthy();
  });

  it("calls onSelect with the clicked session id", () => {
    const onSelect = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={onSelect} onRemove={() => {}} onRename={() => {}} />);
    fireEvent.click(screen.getByText("second"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("shows the empty state when there are no sessions", () => {
    render(<SessionList sessions={[]} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} />);
    expect(screen.getByText("セッションがありません")).toBeTruthy();
  });

  it("offers removal only for stopped sessions and reports the id", () => {
    const onRemove = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={onRemove} onRename={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: "一覧から外す" });
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]);
    expect(onRemove).toHaveBeenCalledWith("b");
  });

  it("shows an unread badge only on rows with unread breaks", () => {
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} />);
    const badges = screen.getAllByTestId("unread-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain("2");
    expect(screen.getAllByTestId("session-row")[1].getAttribute("data-unread")).toBe("2");
  });

  it("disables rename while input is not allowed (Claude working / waiting)", () => {
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} />);
    expect((screen.getByRole("button", { name: "名前を変える" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers rename for sessions that are not stopped", () => {
    const onRename = vi.fn();
    render(<SessionList sessions={[{ ...sessions[0], state: "idle", canInput: true }, sessions[1]]} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={onRename} />);
    const buttons = screen.getAllByRole("button", { name: "名前を変える" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onRename).toHaveBeenCalledWith("a");
  });

  it("K2: line 1 has status dot, name and unread badge; line 2 has the role", () => {
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} />);
    const row = screen.getAllByTestId("session-row")[1];
    const line1 = within(row).getByTestId("session-line-1");
    const line2 = within(row).getByTestId("session-line-2");
    expect(within(line1).getByTestId("status")).toBeTruthy();
    expect(within(line1).getByText("second")).toBeTruthy();
    expect(within(line1).getByTestId("unread-badge").textContent).toContain("2");
    expect(line2.textContent).toBe("シェル");
  });

  it("K3: rename / remove are small right-edge buttons with aria-label and title", () => {
    const withIdle = [{ ...sessions[0], state: "idle" as const, canInput: true }, sessions[1]];
    render(<SessionList sessions={withIdle} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} />);
    const rows = screen.getAllByTestId("session-row");
    const rename = within(rows[0]).getByRole("button", { name: "名前を変える" });
    const remove = within(rows[1]).getByRole("button", { name: "一覧から外す" });
    expect(rename.getAttribute("title")).toBe("名前を変える");
    expect(remove.getAttribute("title")).toBe("一覧から外す");
    expect(rename.className).toContain("comp-btn--sm");
    expect(remove.className).toContain("comp-btn--sm");
    // 右端 = 行の最後の子（選択ボタンの後ろ）
    expect(rows[0].lastElementChild?.contains(rename)).toBe(true);
    expect(rows[1].lastElementChild?.contains(remove)).toBe(true);
    expect(within(rows[0]).queryByRole("button", { name: "一覧から外す" })).toBeNull();
    expect(within(rows[1]).queryByRole("button", { name: "名前を変える" })).toBeNull();
  });

  it("K4: selected row is marked by aria-current and the selected class; clicking the row selects it", () => {
    const onSelect = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId="a" onSelect={onSelect} onRemove={() => {}} onRename={() => {}} />);
    const rows = screen.getAllByTestId("session-row");
    expect(rows[0].className).toContain("ac-session--selected");
    expect(rows[1].className).not.toContain("ac-session--selected");
    expect(within(rows[0]).getByRole("button", { current: true })).toBeTruthy();
    fireEvent.click(within(rows[1]).getByText("シェル"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});
