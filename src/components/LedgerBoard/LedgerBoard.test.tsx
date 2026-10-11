// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { LedgerGroups } from "../../types";
import { LedgerBoard } from "./LedgerBoard";

const groups: LedgerGroups = {
  IN_PROGRESS: [
    { branch: "release/a", result: { kind: "found", state: "IN_PROGRESS" } },
    { branch: "release/b", result: { kind: "found", state: "IN_PROGRESS" } },
  ],
  REVIEW: [],
  DONE: [{ branch: "release/c", result: { kind: "found", state: "DONE" } }],
  OTHER: [],
  UNREGISTERED: [{ branch: "release/d", result: { kind: "unregistered" } }],
};

describe("LedgerBoard", () => {
  it("shows the count per column", () => {
    render(<LedgerBoard snapshot={{ groups, errors: [] }} onRefresh={() => {}} />);
    expect(screen.getByTestId("ledger-col-IN_PROGRESS").getAttribute("data-count")).toBe("2");
    expect(screen.getByTestId("ledger-col-REVIEW").getAttribute("data-count")).toBe("0");
    expect(screen.getByTestId("ledger-col-UNREGISTERED").getAttribute("data-count")).toBe("1");
    expect(screen.getAllByTestId("ledger-card").length).toBe(4);
  });

  it("renders empty columns before data has loaded", () => {
    render(<LedgerBoard snapshot={null} onRefresh={() => {}} />);
    expect(screen.getByTestId("ledger-col-DONE").getAttribute("data-count")).toBe("0");
  });

  it("calls onRefresh from the refresh button", () => {
    const onRefresh = vi.fn();
    render(<LedgerBoard snapshot={{ groups, errors: [] }} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText("更新"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("shows a ledger error callout, separate from the unregistered column", () => {
    render(<LedgerBoard snapshot={{ groups, errors: [{ branch: "scripts/ledger-lookup.sh", message: "exit 127" }] }} onRefresh={() => {}} />);
    expect(screen.getByText("台帳を読めません")).toBeTruthy();
    expect(screen.getByTestId("ledger-error").textContent).toContain("exit 127");
    expect(screen.getByTestId("ledger-col-UNREGISTERED").getAttribute("data-count")).toBe("1");
  });

  it("shows no error callout when there are no errors", () => {
    render(<LedgerBoard snapshot={{ groups, errors: [] }} onRefresh={() => {}} />);
    expect(screen.queryByText("台帳を読めません")).toBeNull();
  });
});
