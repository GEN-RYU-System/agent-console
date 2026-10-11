// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { RoleView } from "../../types";
import { NewSessionForm } from "./NewSessionForm";

const roles: RoleView[] = [
  { id: "shell", labelKey: "role.shell", needsWorktree: false },
  { id: "sonnet-impl", labelKey: "role.sonnetImpl", needsWorktree: true },
];

describe("NewSessionForm", () => {
  it("submits name and role without a branch for roles that need no worktree", () => {
    const onSubmit = vi.fn();
    render(<NewSessionForm roles={roles} busy={false} error={null} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("名前", { exact: false }), { target: { value: "s1" } });
    fireEvent.submit(screen.getByTestId("new-session-form"));
    expect(onSubmit).toHaveBeenCalledWith({ name: "s1", roleId: "shell", branch: undefined });
  });

  it("asks for a branch when the role needs a worktree", () => {
    const onSubmit = vi.fn();
    render(<NewSessionForm roles={roles} busy={false} error={null} onSubmit={onSubmit} />);
    expect(screen.queryByLabelText("ブランチ名", { exact: false })).toBeNull();
    fireEvent.change(screen.getByLabelText("役割", { exact: false }), { target: { value: "sonnet-impl" } });
    fireEvent.change(screen.getByLabelText("名前", { exact: false }), { target: { value: "s2" } });
    fireEvent.change(screen.getByLabelText("ブランチ名", { exact: false }), { target: { value: "release/topic" } });
    fireEvent.submit(screen.getByTestId("new-session-form"));
    expect(onSubmit).toHaveBeenCalledWith({ name: "s2", roleId: "sonnet-impl", branch: "release/topic" });
  });

  it("shows a server error", () => {
    render(<NewSessionForm roles={roles} busy={false} error="boom" onSubmit={() => {}} />);
    expect(screen.getByText("boom")).toBeTruthy();
  });
});
