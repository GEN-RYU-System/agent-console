// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api";
import "../../i18n";
import type { ResumeTarget, RoleView } from "../../types";
import { ReservationEditor } from "./ReservationEditor";

const fetchResumeTargets = vi.fn();
const previewReservationSchedule = vi.fn();
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ApiError: actual.ApiError, fetchResumeTargets: () => fetchResumeTargets(), previewReservationSchedule: (...args: unknown[]) => previewReservationSchedule(...args) };
});

const roles: RoleView[] = [
  { id: "opus-designer", labelKey: "role.opusDesigner", needsWorktree: false },
  { id: "sonnet-impl", labelKey: "role.sonnetImpl", needsWorktree: true },
];
const items: ResumeTarget[] = [
  { kind: "main", path: "/repo", branch: "main", roleId: "opus-designer" },
  { kind: "worktree", path: "/wt/release-alpha", branch: "release/alpha", roleId: "sonnet-impl" },
  { kind: "worktree", path: "/wt/detached", branch: null, roleId: "sonnet-impl" },
];
const saveButton = (): HTMLButtonElement => screen.getByRole("button", { name: "予約する" }) as HTMLButtonElement;
const pickRole = (id: string): void => { fireEvent.change(screen.getByLabelText("役割"), { target: { value: id } }); };
const fillRest = (): void => {
  fireEvent.change(screen.getByLabelText(/^名前/), { target: { value: "n" } });
  fireEvent.change(screen.getByLabelText(/^日付/), { target: { value: "2026-12-01" } });
  fireEvent.change(screen.getByLabelText(/^Claude に送る指示/), { target: { value: "p" } });
};

beforeEach(() => { fetchResumeTargets.mockReset(); fetchResumeTargets.mockResolvedValue({ items }); previewReservationSchedule.mockReset(); previewReservationSchedule.mockResolvedValue({ ready: true, overlap: null }); });

describe("ReservationEditor launch target", () => {
  it("R1: a main-checkout role shows no cwd/branch input and sends neither", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationEditor roles={roles} onSave={onSave} />);
    expect(screen.getByText("本店（いつもの作業場所）で動きます")).toBeTruthy();
    expect(screen.queryByLabelText("ブランチ")).toBeNull();
    fillRest();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const sent = onSave.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toMatchObject({ roleId: "opus-designer" });
    expect("cwd" in sent).toBe(false);
    expect("branch" in sent).toBe(false);
  });

  it("R3/R4: a worktree role picks from worktree rows and sends cwd and that row's branch", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationEditor roles={roles} onSave={onSave} />);
    pickRole("sonnet-impl");
    await waitFor(() => expect(screen.getByLabelText(/作業用コピー/)).toBeTruthy());
    const opts = (screen.getAllByRole("option") as HTMLOptionElement[]).filter((o) => o.value.startsWith("/"));
    expect(opts.map((o) => o.value)).toEqual(["/wt/release-alpha", "/wt/detached"]);
    expect(opts[1].disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/作業用コピー/), { target: { value: "/wt/release-alpha" } });
    fillRest();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ roleId: "sonnet-impl", cwd: "/wt/release-alpha", branch: "release/alpha" });
  });

  it("v0.44.0: a role with reservable:false is not offered", () => {
    render(<ReservationEditor roles={[...roles, { id: "hidden", labelKey: "role.shell", needsWorktree: false, reservable: false }]} onSave={vi.fn()} />);
    const values = (screen.getByLabelText("役割") as HTMLSelectElement).options;
    expect(Array.from(values).map((o) => o.value)).toEqual(["opus-designer", "sonnet-impl"]);
  });

  it("v0.44.0: a role with reservable:false placed first is not the default; the first reservable role is", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationEditor roles={[{ id: "hidden", labelKey: "role.shell", needsWorktree: false, reservable: false }, ...roles]} onSave={onSave} />);
    expect((screen.getByLabelText("役割") as HTMLSelectElement).value).toBe("opus-designer");
    fillRest();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ roleId: "opus-designer" });
  });

  it("changing the role clears the picked worktree", async () => {
    render(<ReservationEditor roles={roles} onSave={vi.fn()} />);
    pickRole("sonnet-impl");
    await waitFor(() => expect(screen.getByLabelText(/作業用コピー/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/作業用コピー/), { target: { value: "/wt/release-alpha" } });
    pickRole("opus-designer");
    pickRole("sonnet-impl");
    await waitFor(() => expect((screen.getByLabelText(/作業用コピー/) as HTMLSelectElement).value).toBe(""));
  });

  it("R6: a load failure blocks saving for a worktree role but not for a main role", async () => {
    fetchResumeTargets.mockRejectedValue(new Error("x"));
    render(<ReservationEditor roles={roles} onSave={vi.fn()} />);
    expect(saveButton().disabled).toBe(false);
    pickRole("sonnet-impl");
    await waitFor(() => expect(screen.getByText("作業用コピーの一覧を読めませんでした")).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
    pickRole("opus-designer");
    expect(saveButton().disabled).toBe(false);
  });

  it("R6: an empty worktree list blocks saving for a worktree role", async () => {
    fetchResumeTargets.mockResolvedValue({ items: [items[0]] });
    render(<ReservationEditor roles={roles} onSave={vi.fn()} />);
    pickRole("sonnet-impl");
    await waitFor(() => expect(screen.getByText("作業用コピーがありません")).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
  });
});

const overlap = { ready: true, overlap: { name: "相手A", kind: "reservation", at: "2026-10-23T10:00+09:00", before: "2026-10-23T09:00+09:00", after: null } };
const slow = { timeout: 3000 };

describe("ReservationEditor overlap notice", () => {
  it("S1 an overlapping answer shows the other's name and the JST time", async () => {
    previewReservationSchedule.mockResolvedValue(overlap);
    render(<ReservationEditor roles={roles} onSave={vi.fn()} />);
    fillRest();
    const box = await screen.findByTestId("schedule-overlap", {}, slow);
    expect(box.textContent).toContain("相手A");
    expect(box.textContent).toContain("2026/10/23 10:00 JST");
    expect(box.textContent).toContain("前 2026/10/23 09:00 JST ／ 後 なし");
    expect(previewReservationSchedule).toHaveBeenLastCalledWith("2026-12-01", "09:00");
  });

  it("S2 no overlap shows nothing", async () => {
    render(<ReservationEditor roles={roles} onSave={vi.fn()} />);
    fillRest();
    await waitFor(() => expect(previewReservationSchedule).toHaveBeenCalled(), slow);
    expect(screen.queryByTestId("schedule-overlap")).toBeNull();
  });

  it("S3 the save button still works while the notice shows", async () => {
    previewReservationSchedule.mockResolvedValue(overlap);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationEditor roles={roles} onSave={onSave} />);
    fillRest();
    await screen.findByTestId("schedule-overlap", {}, slow);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it("S4 an older answer arriving late is dropped", async () => {
    let first: (v: unknown) => void = () => undefined;
    previewReservationSchedule.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }));
    previewReservationSchedule.mockResolvedValue({ ready: true, overlap: null });
    render(<ReservationEditor roles={roles} onSave={vi.fn()} />);
    fillRest();
    await waitFor(() => expect(previewReservationSchedule).toHaveBeenCalledTimes(1), slow);
    fireEvent.change(screen.getByLabelText(/^日付/), { target: { value: "2026-12-02" } });
    await waitFor(() => expect(previewReservationSchedule).toHaveBeenCalledTimes(2), slow);
    first(overlap);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("schedule-overlap")).toBeNull();
  });

  it("S5 a 400 shows nothing, another failure shows the could-not-check notice", async () => {
    previewReservationSchedule.mockRejectedValue(new ApiError("bad", 400));
    const view = render(<ReservationEditor roles={roles} onSave={vi.fn()} />);
    fillRest();
    await waitFor(() => expect(previewReservationSchedule).toHaveBeenCalled(), slow);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("schedule-overlap")).toBeNull();
    previewReservationSchedule.mockRejectedValue(new ApiError("boom", 500));
    fireEvent.change(screen.getByLabelText(/^日付/), { target: { value: "2026-12-03" } });
    const box = await screen.findByTestId("schedule-overlap", {}, slow);
    expect(box.textContent).toContain("重なりを確かめられませんでした");
    view.unmount();
  });
});
