// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { RoleView, SessionView } from "../../types";
import { SessionList } from "./SessionList";

const roles: RoleView[] = [{ id: "shell", labelKey: "role.shell", needsWorktree: false }];
const sessions: SessionView[] = [
  { id: "a", name: "first", roleId: "shell", branch: null, cwd: "/", state: "working", createdAt: 1 },
  { id: "b", name: "second", roleId: "shell", branch: null, cwd: "/", state: "stopped", createdAt: 2 },
];

describe("SessionList", () => {
  it("renders name, role label and state for each session", () => {
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} />);
    expect(screen.getAllByTestId("session-row").length).toBe(2);
    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getAllByText("シェル").length).toBe(2);
    expect(screen.getByText("作業中")).toBeTruthy();
    expect(screen.getByText("停止")).toBeTruthy();
  });

  it("calls onSelect with the clicked session id", () => {
    const onSelect = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={onSelect} onRemove={() => {}} />);
    fireEvent.click(screen.getByText("second"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("shows the empty state when there are no sessions", () => {
    render(<SessionList sessions={[]} roles={roles} selectedId={null} onSelect={() => {}} onRemove={() => {}} />);
    expect(screen.getByText("セッションがありません")).toBeTruthy();
  });

  it("offers removal only for stopped sessions and reports the id", () => {
    const onRemove = vi.fn();
    render(<SessionList sessions={sessions} roles={roles} selectedId={null} onSelect={() => {}} onRemove={onRemove} />);
    const buttons = screen.getAllByText("一覧から外す");
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]);
    expect(onRemove).toHaveBeenCalledWith("b");
  });
});
