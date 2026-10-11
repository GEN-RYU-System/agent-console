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
    render(<LedgerBoard groups={groups} onRefresh={() => {}} />);
    expect(screen.getByTestId("ledger-col-IN_PROGRESS").getAttribute("data-count")).toBe("2");
    expect(screen.getByTestId("ledger-col-REVIEW").getAttribute("data-count")).toBe("0");
    expect(screen.getByTestId("ledger-col-UNREGISTERED").getAttribute("data-count")).toBe("1");
    expect(screen.getAllByTestId("ledger-card").length).toBe(4);
  });

  it("renders empty columns before data has loaded", () => {
    render(<LedgerBoard groups={null} onRefresh={() => {}} />);
    expect(screen.getByTestId("ledger-col-DONE").getAttribute("data-count")).toBe("0");
  });

  it("calls onRefresh from the refresh button", () => {
    const onRefresh = vi.fn();
    render(<LedgerBoard groups={groups} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText("更新"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
