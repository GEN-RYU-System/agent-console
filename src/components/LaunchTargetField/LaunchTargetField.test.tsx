// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { ResumeTarget, RoleView } from "../../types";
import { LaunchTargetField } from "./LaunchTargetField";

const main: RoleView = { id: "opus-designer", labelKey: "role.opusDesigner", needsWorktree: false };
const wt: RoleView = { id: "sonnet-impl", labelKey: "role.sonnetImpl", needsWorktree: true };
const targets: ResumeTarget[] = [
  { kind: "main", path: "/repo", branch: "main", roleId: "opus-designer" },
  { kind: "worktree", path: "/wt/release-alpha", branch: "release/alpha", roleId: "sonnet-impl" },
  { kind: "worktree", path: "/wt/detached", branch: null, roleId: "sonnet-impl" },
];
const base = { role: wt, targets, loadError: false, value: "", onChange: () => {} };

describe("LaunchTargetField", () => {
  it("R1: a main-checkout role shows one sentence and no input", () => {
    const { container } = render(<LaunchTargetField {...base} role={main} />);
    expect(screen.getByText("本店（いつもの作業場所）で動きます")).toBeTruthy();
    expect(container.querySelector("select, input")).toBeNull();
  });

  it("R3: a worktree role lists only worktree rows by branch; a branchless row cannot be chosen", () => {
    render(<LaunchTargetField {...base} />);
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((o) => [o.value, o.textContent, o.disabled])).toEqual([
      ["", "選んでください", true],
      ["/wt/release-alpha", "release/alpha", false],
      ["/wt/detached", "detached（ブランチなし・選べません）", true],
    ]);
    expect(screen.queryByText("main")).toBeNull();
  });

  it("R3: choosing a row reports its path", () => {
    const onChange = vi.fn();
    render(<LaunchTargetField {...base} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/作業用コピー/), { target: { value: "/wt/release-alpha" } });
    expect(onChange).toHaveBeenCalledWith("/wt/release-alpha");
  });

  it("shows a disabled select while loading", () => {
    render(<LaunchTargetField {...base} targets={null} />);
    expect((screen.getByLabelText(/作業用コピー/) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("一覧を読み込み中…")).toBeTruthy();
  });

  it("R6: a load failure and an empty list each show a warning and no select", () => {
    const failed = render(<LaunchTargetField {...base} loadError />);
    expect(screen.getByText("作業用コピーの一覧を読めませんでした")).toBeTruthy();
    expect(failed.container.querySelector("select")).toBeNull();
    failed.unmount();
    const empty = render(<LaunchTargetField {...base} targets={[targets[0]]} />);
    expect(screen.getByText("作業用コピーがありません")).toBeTruthy();
    expect(empty.container.querySelector("select")).toBeNull();
  });
});
