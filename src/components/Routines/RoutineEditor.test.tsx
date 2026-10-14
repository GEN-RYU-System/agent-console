// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { ResumeTarget, RoleView, Routine } from "../../types";
import { RoutineEditor } from "./RoutineEditor";

const fetchResumeTargets = vi.fn();
vi.mock("../../api", () => ({ fetchResumeTargets: () => fetchResumeTargets() }));

const roles: RoleView[] = [
  { id: "opus-designer", labelKey: "role.opusDesigner", needsWorktree: false },
  { id: "sonnet-impl", labelKey: "role.sonnetImpl", needsWorktree: true },
];
const items: ResumeTarget[] = [
  { kind: "main", path: "/repo", branch: "main", roleId: "opus-designer" },
  { kind: "worktree", path: "/wt/release-alpha", branch: "release/alpha", roleId: "sonnet-impl" },
  { kind: "worktree", path: "/wt/detached", branch: null, roleId: "sonnet-impl" },
];
const saveButton = (): HTMLButtonElement => screen.getByRole("button", { name: /^(保存|登録)/ }) as HTMLButtonElement;
const pickRole = (id: string): void => { fireEvent.change(screen.getByLabelText("役割"), { target: { value: id } }); };
const fillRest = (): void => {
  fireEvent.change(screen.getByLabelText(/^名前/), { target: { value: "n" } });
  fireEvent.change(screen.getByLabelText(/^Claude に送る指示/), { target: { value: "p" } });
};

beforeEach(() => { fetchResumeTargets.mockReset(); fetchResumeTargets.mockResolvedValue({ items }); });

describe("RoutineEditor launch target (new)", () => {
  it("R7/R1: a main-checkout role shows no input and sends neither cwd nor branch", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RoutineEditor roles={roles} onSave={onSave} />);
    expect(screen.getByText("本店（いつもの作業場所）で動きます")).toBeTruthy();
    fillRest();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const sent = onSave.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toMatchObject({ roleId: "opus-designer" });
    expect("cwd" in sent).toBe(false);
    expect("branch" in sent).toBe(false);
  });

  it("R7/R3/R4: a worktree role picks from worktree rows and sends cwd and branch", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RoutineEditor roles={roles} onSave={onSave} />);
    pickRole("sonnet-impl");
    await waitFor(() => expect(screen.getByLabelText(/作業用コピー/)).toBeTruthy());
    const opts = (screen.getAllByRole("option") as HTMLOptionElement[]).filter((o) => o.value.startsWith("/"));
    expect(opts.map((o) => [o.value, o.disabled])).toEqual([["/wt/release-alpha", false], ["/wt/detached", true]]);
    fireEvent.change(screen.getByLabelText(/作業用コピー/), { target: { value: "/wt/release-alpha" } });
    fillRest();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ roleId: "sonnet-impl", cwd: "/wt/release-alpha", branch: "release/alpha" });
  });

  it("R7/R6: load failure or an empty list blocks saving for a worktree role only", async () => {
    fetchResumeTargets.mockRejectedValue(new Error("x"));
    const failed = render(<RoutineEditor roles={roles} onSave={vi.fn()} />);
    pickRole("sonnet-impl");
    await waitFor(() => expect(screen.getByText("作業用コピーの一覧を読めませんでした")).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
    pickRole("opus-designer");
    expect(saveButton().disabled).toBe(false);
    failed.unmount();
    fetchResumeTargets.mockResolvedValue({ items: [items[0]] });
    render(<RoutineEditor roles={roles} onSave={vi.fn()} />);
    pickRole("sonnet-impl");
    await waitFor(() => expect(screen.getByText("作業用コピーがありません")).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
  });
});

describe("RoutineEditor (edit)", () => {
  const routine: Routine = { id: "r1", name: "daily", enabled: true, roleId: "sonnet-impl", cwd: "/wt/release-alpha", branch: "release/alpha", timeZone: "Asia/Tokyo", weekdays: [1], timeHHmm: "09:00", promptText: "hi", createdAt: 1, updatedAt: 1, events: [] };

  it("R8: role, cwd and branch stay as disabled displays, are re-sent unchanged, and no list is fetched", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<RoutineEditor routine={routine} roles={roles} onSave={onSave} />);
    for (const label of ["役割", "作業場所", "ブランチ"]) expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("作業場所") as HTMLInputElement).value).toBe("/wt/release-alpha");
    expect((screen.getByLabelText("ブランチ") as HTMLInputElement).value).toBe("release/alpha");
    expect(fetchResumeTargets).not.toHaveBeenCalled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ roleId: "sonnet-impl", cwd: "/wt/release-alpha", branch: "release/alpha" });
  });
});
