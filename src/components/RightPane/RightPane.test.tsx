// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { LedgerSnapshot } from "../../types";

vi.mock("../ActivityPane/ActivityPane", () => ({
  ActivityPane: ({ sessionId, rev }: { sessionId: string; rev: number }) => <div data-testid="activity-pane-stub">{`${sessionId}:${rev}`}</div>,
}));
vi.mock("../LedgerBoard/LedgerBoard", () => ({ LedgerBoard: () => <div data-testid="ledger-board-stub">ledger</div> }));

const { RightPane } = await import("./RightPane");

const LEDGER: LedgerSnapshot = { groups: { IN_PROGRESS: [], REVIEW: [], DONE: [], OTHER: [], UNREGISTERED: [] }, errors: [] };

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const tabs = (): string[] => screen.getAllByRole("tab").map((t) => t.textContent ?? "");
const selected = (): string[] => screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent ?? "");

describe("K1: 右の欄のタブ", () => {
  it("セッションを選んでいないときは「台帳」だけ。台帳が開いている", () => {
    render(<RightPane sessionId={null} rev={0} state="unknown" ledger={LEDGER} onRefresh={() => undefined} />);
    expect(tabs()).toEqual(["台帳"]);
    expect(screen.getByTestId("ledger-board-stub")).toBeTruthy();
    expect(screen.queryByTestId("activity-pane-stub")).toBeNull();
  });

  it("セッションを選ぶと「このセッション」と「台帳」が出て、「このセッション」が先に開く", () => {
    render(<RightPane sessionId="s1" rev={3} state="working" ledger={LEDGER} onRefresh={() => undefined} />);
    expect(tabs()).toEqual(["このセッション", "台帳"]);
    expect(selected()).toEqual(["このセッション"]);
    expect(screen.getByTestId("activity-pane-stub").textContent).toBe("s1:3");
    expect(screen.queryByTestId("ledger-board-stub")).toBeNull();
  });

  it("「台帳」を押すと台帳に切り替わる。別のセッションを選ぶと、また「このセッション」が先に開く", () => {
    const { rerender } = render(<RightPane sessionId="s1" rev={0} state="working" ledger={LEDGER} onRefresh={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "台帳" }));
    expect(selected()).toEqual(["台帳"]);
    expect(screen.getByTestId("ledger-board-stub")).toBeTruthy();
    rerender(<RightPane sessionId="s2" rev={0} state="working" ledger={LEDGER} onRefresh={() => undefined} />);
    expect(selected()).toEqual(["このセッション"]);
    expect(screen.getByTestId("activity-pane-stub").textContent).toBe("s2:0");
  });

  it("セッションの選択が外れたら「台帳」だけに戻る", () => {
    const { rerender } = render(<RightPane sessionId="s1" rev={0} state="working" ledger={LEDGER} onRefresh={() => undefined} />);
    rerender(<RightPane sessionId={null} rev={0} state="unknown" ledger={LEDGER} onRefresh={() => undefined} />);
    expect(tabs()).toEqual(["台帳"]);
    expect(screen.getByTestId("ledger-board-stub")).toBeTruthy();
  });
});
