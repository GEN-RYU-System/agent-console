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
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    expect(screen.getAllByTestId("session-row").length).toBe(2);
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getAllByText("シェル").length).toBe(2);
    expect(screen.getByText("作業中")).toBeTruthy();
    expect(screen.getByText("停止")).toBeTruthy();
  });

  it("calls onSelect with the clicked session id", () => {
    const onSelect = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={onSelect} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    fireEvent.click(screen.getByText("second"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("shows the empty state when there are no sessions", () => {
    render(<SessionList sessions={[]} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    expect(screen.getByText("セッションがありません")).toBeTruthy();
  });

  it("offers removal only for stopped sessions and reports the id", () => {
    const onRemove = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={onRemove} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: "一覧から外す" });
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]);
    expect(onRemove).toHaveBeenCalledWith("b");
  });

  it("offers 閉じる only for running sessions and reports the id (stopped rows keep 一覧から外す)", () => {
    const onClose = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={onClose} onMove={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: "セッションを閉じる" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("title")).toBe("セッションを閉じる");
    expect(within(screen.getAllByTestId("session-row")[0]).getByRole("button", { name: "セッションを閉じる" })).toBe(buttons[0]);
    fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalledWith("a");
  });

  it("shows an unread badge only on rows with unread breaks", () => {
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    const badges = screen.getAllByTestId("unread-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain("2");
    expect(screen.getAllByTestId("session-row")[1].getAttribute("data-unread")).toBe("2");
  });

  it("K2: there is no rename button on any row; the select button advertises F2", () => {
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    expect(screen.queryByRole("button", { name: "名前を変える" })).toBeNull();
    for (const row of screen.getAllByTestId("session-row")) {
      expect(row.querySelector('[aria-keyshortcuts="F2"]')).toBeTruthy();
    }
  });

  it("K1: double-clicking a row opens rename, but not for a stopped row", () => {
    const onRename = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={onRename} onClose={() => {}} onMove={() => {}} />);
    fireEvent.doubleClick(screen.getByText("first"));
    expect(onRename).toHaveBeenCalledWith("a");
    onRename.mockClear();
    fireEvent.doubleClick(screen.getByText("second"));
    expect(onRename).not.toHaveBeenCalled();
  });

  it("K4: shows the queued name on the row only while a rename is pending", () => {
    render(<SessionList sessions={[{ ...sessions[0], pendingName: "next-name" }, sessions[1]]} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    const pending = screen.getAllByTestId("pending-name");
    expect(pending).toHaveLength(1);
    expect(pending[0].textContent).toContain("予約: next-name");
  });

  it("N1: F2 on the select button opens rename for a running row, but not for a stopped row", () => {
    const onRename = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={onRename} onClose={() => {}} onMove={() => {}} />);
    const select = (i: number) => within(screen.getAllByTestId("session-row")[i]).getByRole("button", { name: /^(?!.*(閉じる|一覧から外す))/ });
    const notPrevented = fireEvent.keyDown(select(0), { key: "F2" });
    expect(onRename).toHaveBeenCalledWith("a");
    expect(notPrevented).toBe(false);
    onRename.mockClear();
    fireEvent.keyDown(select(1), { key: "F2" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("v0.10.1: line 1 has only the status dot and the name (no unread badge, no state text, no role, no CI)", () => {
    const withCi: SessionView[] = [sessions[0], { ...sessions[1], ci: "fail", pendingName: "next" }];
    render(<SessionList sessions={withCi} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    const row = screen.getAllByTestId("session-row")[1];
    const line1 = within(row).getByTestId("session-line-1");
    expect(within(line1).getByTestId("status").getAttribute("data-state")).toBe("stopped");
    expect(within(line1).getByTestId("status").textContent).toBe("");
    expect(within(line1).getByText("second")).toBeTruthy();
    expect(within(line1).queryByTestId("unread-badge")).toBeNull();
    expect(within(line1).queryByTestId("ci-badge")).toBeNull();
    expect(within(line1).queryByTestId("state-badge")).toBeNull();
    expect(line1.textContent).not.toContain("停止");
    expect(line1.textContent).not.toContain("シェル");
  });

  it("v0.10.1: line 2 has the role, the state badge, the unread badge, the CI badge and the pending name, in this order", () => {
    const row0: SessionView = { ...sessions[0], unread: 3, ci: "pending", pendingName: "next" };
    render(<SessionList sessions={[row0]} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    const line2 = within(screen.getByTestId("session-row")).getByTestId("session-line-2");
    const role = within(line2).getByText("シェル");
    const state = within(line2).getByTestId("state-badge");
    const unread = within(line2).getByTestId("unread-badge");
    expect(unread.textContent).toContain("3");
    const ci = within(line2).getByTestId("ci-badge");
    const pending = within(line2).getByTestId("pending-name");
    expect(state.textContent).toBe("作業中");
    expect(state.querySelector(".comp-badge--neutral")).toBeTruthy();
    const follows = (a: Node, b: Node): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(role, state)).toBe(true);
    expect(follows(state, unread)).toBe(true);
    expect(follows(unread, ci)).toBe(true);
    expect(follows(ci, pending)).toBe(true);
  });

  it("v0.10.0 K5: the state text comes from the shared STATE_LABEL_KEY table for every state", () => {
    const all: SessionView[] = (["working", "waiting", "idle", "no-claude", "stopped", "unknown"] as const).map((state) => ({ ...sessions[0], id: state, name: state, state }));
    render(<SessionList sessions={all} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    const texts = screen.getAllByTestId("state-badge").map((n) => n.textContent);
    expect(texts).toEqual(["作業中", "回答待ち", "指示待ち", "Claude 未起動", "停止", "不明"]);
  });

  describe("v0.10.0 K6・K7 reordering", () => {
    const three: SessionView[] = ["a", "b", "c"].map((id, i) => ({ ...sessions[0], id, name: id, createdAt: i }));
    const renderThree = (onMove: (id: string, toIndex: number) => void) =>
      render(<SessionList sessions={three} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={onMove} />);

    it("K6: every row is draggable", () => {
      renderThree(() => {});
      for (const row of screen.getAllByTestId("session-row")) expect(row.getAttribute("draggable")).toBe("true");
    });

    it("K6: dropping row a on row c moves a to index 2", () => {
      const onMove = vi.fn();
      renderThree(onMove);
      const rows = screen.getAllByTestId("session-row");
      fireEvent.dragStart(rows[0]);
      fireEvent.dragOver(rows[2]);
      fireEvent.drop(rows[2]);
      expect(onMove).toHaveBeenCalledWith("a", 2);
    });

    it("K6: dropping row c on row a moves c to index 0", () => {
      const onMove = vi.fn();
      renderThree(onMove);
      const rows = screen.getAllByTestId("session-row");
      fireEvent.dragStart(rows[2]);
      fireEvent.drop(rows[0]);
      expect(onMove).toHaveBeenCalledWith("c", 0);
    });

    it("K6: dropping a row on itself, or dropping without a drag in progress, does nothing", () => {
      const onMove = vi.fn();
      renderThree(onMove);
      const rows = screen.getAllByTestId("session-row");
      fireEvent.dragStart(rows[1]);
      fireEvent.drop(rows[1]);
      fireEvent.dragEnd(rows[1]);
      fireEvent.drop(rows[0]);
      expect(onMove).not.toHaveBeenCalled();
    });

    it("K7: Alt+ArrowUp / Alt+ArrowDown on the select button moves the row by one", () => {
      const onMove = vi.fn();
      renderThree(onMove);
      const select = (i: number) => within(screen.getAllByTestId("session-row")[i]).getByRole("button", { name: /^(?!.*(閉じる|名前を変える))/ });
      fireEvent.keyDown(select(1), { key: "ArrowUp", altKey: true });
      expect(onMove).toHaveBeenLastCalledWith("b", 0);
      fireEvent.keyDown(select(1), { key: "ArrowDown", altKey: true });
      expect(onMove).toHaveBeenLastCalledWith("b", 2);
    });

    it("K7: does nothing at the ends and without Alt, and stops the default action when it moves", () => {
      const onMove = vi.fn();
      renderThree(onMove);
      const select = (i: number) => within(screen.getAllByTestId("session-row")[i]).getByRole("button", { name: /^(?!.*(閉じる|名前を変える))/ });
      fireEvent.keyDown(select(0), { key: "ArrowUp", altKey: true });
      fireEvent.keyDown(select(2), { key: "ArrowDown", altKey: true });
      fireEvent.keyDown(select(1), { key: "ArrowUp" });
      expect(onMove).not.toHaveBeenCalled();
      const notPrevented = fireEvent.keyDown(select(1), { key: "ArrowUp", altKey: true });
      expect(notPrevented).toBe(false);
    });
  });

  it("K3: close (running row) / remove (stopped row) are small right-edge buttons with aria-label and title", () => {
    const withIdle = [{ ...sessions[0], state: "idle" as const, canInput: true }, sessions[1]];
    render(<SessionList sessions={withIdle} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    const rows = screen.getAllByTestId("session-row");
    const close = within(rows[0]).getByRole("button", { name: "セッションを閉じる" });
    const remove = within(rows[1]).getByRole("button", { name: "一覧から外す" });
    expect(close.getAttribute("title")).toBe("セッションを閉じる");
    expect(remove.getAttribute("title")).toBe("一覧から外す");
    expect(close.className).toContain("comp-btn--sm");
    expect(remove.className).toContain("comp-btn--sm");
    // 右端 = 行の最後の子（選択ボタンの後ろ）。動いている行は「閉じる」、停止中の行は「外す」
    expect(rows[0].lastElementChild?.contains(close)).toBe(true);
    expect(rows[1].lastElementChild?.contains(remove)).toBe(true);
    expect(within(rows[0]).queryByRole("button", { name: "一覧から外す" })).toBeNull();
    expect(within(rows[1]).queryByRole("button", { name: "セッションを閉じる" })).toBeNull();
    expect(within(rows[0]).queryByRole("button", { name: "名前を変える" })).toBeNull();
    expect(within(rows[1]).queryByRole("button", { name: "名前を変える" })).toBeNull();
  });

  it("K4: selected row is marked by aria-current and the selected class; clicking the row selects it", () => {
    const onSelect = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId="a" onSelect={onSelect} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    const rows = screen.getAllByTestId("session-row");
    expect(rows[0].className).toContain("ac-session--selected");
    expect(rows[1].className).not.toContain("ac-session--selected");
    expect(within(rows[0]).getByRole("button", { current: true })).toBeTruthy();
    fireEvent.click(within(rows[1]).getByText("シェル"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("v0.5.0 K3: ci があるときだけ名前の横に CI の印を出す（失敗=danger / 実行中=info / 成功=success）", () => {
    const withCi: SessionView[] = [
      { ...sessions[0], id: "f", name: "f", ci: "fail" },
      { ...sessions[0], id: "p", name: "p", ci: "pending" },
      { ...sessions[0], id: "o", name: "o", ci: "pass" },
      { ...sessions[0], id: "n", name: "n" },
    ];
    render(<SessionList sessions={withCi} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={() => {}} onClose={() => {}} onMove={() => {}} />);
    const rows = screen.getAllByTestId("session-row");
    const badge = (i: number) => within(rows[i]).queryByTestId("ci-badge");
    expect(badge(0)?.textContent).toBe("CI 失敗");
    expect(badge(0)?.querySelector(".comp-badge--danger")).toBeTruthy();
    expect(badge(1)?.textContent).toBe("CI 実行中");
    expect(badge(1)?.querySelector(".comp-badge--info")).toBeTruthy();
    expect(badge(2)?.textContent).toBe("CI 成功");
    expect(badge(2)?.querySelector(".comp-badge--success")).toBeTruthy();
    expect(badge(3)).toBeNull();
  });
});
