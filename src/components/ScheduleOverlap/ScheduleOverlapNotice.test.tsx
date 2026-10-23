// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../i18n";
import { ScheduleOverlapNotice } from "./ScheduleOverlapNotice";

describe("ScheduleOverlapNotice", () => {
  it("N1 not ready shows the not-ready text", () => {
    render(<ScheduleOverlapNotice preview={{ ready: false }} failed={false} />);
    expect(screen.getByTestId("schedule-overlap").textContent).toContain("予約の一覧をまだ読めていません");
  });

  it("N2 null before/after show なし", () => {
    render(<ScheduleOverlapNotice preview={{ ready: true, overlap: { name: "x", kind: "reservation", at: "2026-10-23T10:00+09:00", before: null, after: null } }} failed={false} />);
    expect(screen.getByTestId("schedule-overlap").textContent).toContain("前 なし ／ 後 なし");
  });

  it("N3 a routine other with date-time before/after is formatted as JST", () => {
    render(<ScheduleOverlapNotice preview={{ ready: true, overlap: { name: "d", kind: "routine", at: "2026-10-23T10:00+09:00", before: "2026-10-23T09:00+09:00", after: "2026-10-23T11:00+09:00" } }} failed={false} />);
    const text = screen.getByTestId("schedule-overlap").textContent ?? "";
    expect(text).toContain("定期実行・2026/10/23 10:00 JST");
    expect(text).toContain("前 2026/10/23 09:00 JST ／ 後 2026/10/23 11:00 JST");
  });

  it("N4 nothing for null preview or null overlap", () => {
    const a = render(<ScheduleOverlapNotice preview={null} failed={false} />);
    expect(a.container.innerHTML).toBe("");
    const b = render(<ScheduleOverlapNotice preview={{ ready: true, overlap: null }} failed={false} />);
    expect(b.container.innerHTML).toBe("");
  });
});
