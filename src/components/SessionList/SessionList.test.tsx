// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { RoleView, SessionView } from "../../types";
import { SessionList } from "./SessionList";

const roles: RoleView[] = [{ id: "shell", labelKey: "role.shell", needsWorktree: false, canResume: false }];
const sessions: SessionView[] = [
  { id: "a", name: "first", roleId: "shell", branch: null, cwd: "/", state: "working", createdAt: 1, unread: 0, hasClaude: true },
  { id: "b", name: "second", roleId: "shell", branch: null, cwd: "/", state: "stopped", createdAt: 2, unread: 2, hasClaude: false },
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
    const buttons = screen.getAllByText("一覧から外す");
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

  it("offers rename for sessions that are not stopped", () => {
    const onRename = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} onRename={onRename} />);
    const buttons = screen.getAllByText("名前を変える");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onRename).toHaveBeenCalledWith("a");
  });
});
