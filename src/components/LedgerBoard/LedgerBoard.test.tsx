// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { LedgerGroups } from "../../types";
import { LedgerBoard } from "./LedgerBoard";

const NOW = new Date(2026, 9, 11, 12, 0).getTime();
const RECENT = NOW - 24 * 60 * 60 * 1000;
const OLD = NOW - 90 * 24 * 60 * 60 * 1000;

afterEach(() => window.localStorage.clear());

const groups: LedgerGroups = {
  IN_PROGRESS: [
    { branch: "release/a", result: { kind: "found", state: "IN_PROGRESS", startedAt: RECENT } },
    { branch: "release/b", result: { kind: "found", state: "IN_PROGRESS", startedAt: OLD } },
  ],
  REVIEW: [],
  DONE: [{ branch: "release/c", result: { kind: "found", state: "DONE", startedAt: RECENT } }],
  OTHER: [],
  UNREGISTERED: [{ branch: "release/d", result: { kind: "unregistered" } }],
};

describe("LedgerBoard", () => {
  it("shows only active states from the last 30 days by default and says how many are hidden", () => {
    render(<LedgerBoard snapshot={{ groups, errors: [] }} onRefresh={() => {}} now={NOW} />);
    expect(screen.getByTestId("ledger-col-IN_PROGRESS").getAttribute("data-count")).toBe("1");
    expect(screen.getByTestId("ledger-col-DONE").getAttribute("data-count")).toBe("0");
    expect(screen.getByTestId("ledger-col-UNREGISTERED").getAttribute("data-count")).toBe("0");
    expect(screen.getAllByTestId("ledger-card").length).toBe(1);
    const summary = screen.getByTestId("ledger-summary");
    expect(summary.getAttribute("data-shown")).toBe("1");
    expect(summary.getAttribute("data-hidden")).toBe("3");
    expect(summary.textContent).toContain("隠れた件数: 3");
  });

  it("shows the count per column when the filter is widened, and remembers the choice", () => {
    render(<LedgerBoard snapshot={{ groups, errors: [] }} onRefresh={() => {}} now={NOW} />);
    fireEvent.change(screen.getByLabelText("期間"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("状態"), { target: { value: "all" } });
    expect(screen.getByTestId("ledger-col-IN_PROGRESS").getAttribute("data-count")).toBe("2");
    expect(screen.getByTestId("ledger-col-REVIEW").getAttribute("data-count")).toBe("0");
    expect(screen.getByTestId("ledger-col-UNREGISTERED").getAttribute("data-count")).toBe("1");
    expect(screen.getAllByTestId("ledger-card").length).toBe(4);
    expect(JSON.parse(window.localStorage.getItem("ac.ledgerFilter") as string)).toEqual({ period: "all", state: "all", query: "" });
  });

  it("counts rows with an unreadable start date separately", () => {
    const withUnknown: LedgerGroups = { ...groups, REVIEW: [{ branch: "release/e", result: { kind: "found", state: "REVIEW", startedAt: null } }] };
    render(<LedgerBoard snapshot={{ groups: withUnknown, errors: [] }} onRefresh={() => {}} now={NOW} />);
    expect(screen.getByTestId("ledger-unknown-date").textContent).toContain("1 件");
  });

  it("renders empty columns before data has loaded", () => {
    render(<LedgerBoard snapshot={null} onRefresh={() => {}} now={NOW} />);
    expect(screen.getByTestId("ledger-col-DONE").getAttribute("data-count")).toBe("0");
  });

  it("calls onRefresh from the refresh button", () => {
    const onRefresh = vi.fn();
    render(<LedgerBoard snapshot={{ groups, errors: [] }} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText("更新"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("shows a ledger error callout, separate from the unregistered column", () => {
    window.localStorage.setItem("ac.ledgerFilter", JSON.stringify({ period: "all", state: "all", query: "" }));
    render(<LedgerBoard snapshot={{ groups, errors: [{ branch: "scripts/ledger-lookup.sh", message: "exit 127" }] }} onRefresh={() => {}} now={NOW} />);
    expect(screen.getByText("台帳を読めません")).toBeTruthy();
    expect(screen.getByTestId("ledger-error").textContent).toContain("exit 127");
    expect(screen.getByTestId("ledger-col-UNREGISTERED").getAttribute("data-count")).toBe("1");
  });

  it("shows no error callout when there are no errors", () => {
    render(<LedgerBoard snapshot={{ groups, errors: [] }} onRefresh={() => {}} />);
    expect(screen.queryByText("台帳を読めません")).toBeNull();
  });
});
