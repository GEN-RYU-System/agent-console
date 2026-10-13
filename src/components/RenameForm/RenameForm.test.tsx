// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { SessionView } from "../../types";
import { RenameForm } from "./RenameForm";

const session: SessionView = { id: "s1", name: "old", roleId: "shell", branch: null, cwd: "/", state: "idle", createdAt: 1, unread: 0, hasClaude: true, canInput: true, canChat: true };

describe("RenameForm", () => {
  it("submits the new name while Claude is waiting or idle", () => {
    const onSubmit = vi.fn();
    render(<RenameForm session={session} busy={false} error={null} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText(/新しい名前/), { target: { value: "new-name" } });
    fireEvent.click(screen.getByRole("button", { name: "変更" }));
    expect(onSubmit).toHaveBeenCalledWith("new-name");
    expect(screen.getByText(/\/rename を送って/)).toBeTruthy();
  });

  it("K8: can submit while Claude is working or waiting, and explains that the name is queued", () => {
    const onSubmit = vi.fn();
    render(<RenameForm session={{ ...session, state: "working", canInput: false }} busy={false} error={null} onSubmit={onSubmit} />);
    expect((screen.getByRole("button", { name: "変更" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("いまは予約になります")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "変更" }));
    expect(onSubmit).toHaveBeenCalledWith("old");
  });

  it("cannot be submitted for a stopped session", () => {
    render(<RenameForm session={{ ...session, state: "stopped", canInput: false }} busy={false} error={null} onSubmit={() => {}} />);
    expect((screen.getByRole("button", { name: "変更" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("いまは予約になります")).toBeNull();
  });

  it("renames the app-side name when Claude is not running, even though no claude is attached", () => {
    render(<RenameForm session={{ ...session, hasClaude: false, state: "no-claude" }} busy={false} error={null} onSubmit={() => {}} />);
    expect((screen.getByRole("button", { name: "変更" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("このアプリでの表示名を変えます。")).toBeTruthy();
  });
});
