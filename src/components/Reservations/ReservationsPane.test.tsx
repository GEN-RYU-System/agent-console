// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { Reservation, RoleView } from "../../types";
import { ReservationsPane } from "./ReservationsPane";

const fetchReservations = vi.fn();
const cancelReservation = vi.fn();
vi.mock("../../api", () => ({
  fetchReservations: () => fetchReservations(),
  cancelReservation: (...args: unknown[]) => cancelReservation(...args),
  createReservation: vi.fn(),
  fetchResumeTargets: () => Promise.resolve({ items: [] }),
  previewReservationSchedule: () => Promise.resolve({ ready: true, overlap: null }),
}));

const roles: RoleView[] = [{ id: "opus-designer", labelKey: "role.opusDesigner", needsWorktree: false }];
const base = (over: Partial<Reservation>): Reservation => ({
  id: "r", name: "n", roleId: "opus-designer", cwd: "/repo", runAt: Date.parse("2026-12-01T01:00:00Z"), runAtJst: "2026-12-01T10:00:00+09:00", timeZone: "Asia/Tokyo",
  promptText: "p", createdBy: "agent", createdAt: 1, updatedAt: 1, status: "pending", ...over,
});

beforeEach(() => { fetchReservations.mockReset(); cancelReservation.mockReset(); });

describe("ReservationsPane purpose display", () => {
  it("W6: work, measure and ui reservations show their own label and note", async () => {
    fetchReservations.mockResolvedValue({ items: [
      base({ id: "w", name: "work-one", workNote: "段取り表を作る" }),
      base({ id: "m", name: "measure-one", purpose: "measure", measureNote: "効果を測る" }),
      base({ id: "u", name: "ui-one", createdBy: "ui" }),
    ] });
    render(<ReservationsPane roles={roles} active />);
    await waitFor(() => expect(screen.getAllByTestId("reservation-row")).toHaveLength(3));
    const rows = screen.getAllByTestId("reservation-row");
    const byName = (name: string) => rows.find((r) => r.textContent?.includes(name)) as HTMLElement;
    expect(byName("work-one").textContent).toContain("AI・作業");
    expect(byName("work-one").textContent).toContain("する内容: 段取り表を作る");
    expect(byName("work-one").textContent).not.toContain("測る内容");
    expect(byName("measure-one").textContent).toContain("AI・測定");
    expect(byName("measure-one").textContent).toContain("測る内容: 効果を測る");
    expect(byName("ui-one").textContent).toContain("画面");
    expect(byName("ui-one").textContent).not.toContain("内容");
  });
});
