// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { AccountResponse } from "../../types";
import { ACCOUNT_REFRESH_MS, AccountBadge } from "./AccountBadge";

const fetchAccount = vi.fn();
vi.mock("../../api", () => ({ fetchAccount: () => fetchAccount() }));

beforeEach(() => {
  vi.useFakeTimers();
  fetchAccount.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function show(account: AccountResponse | Error, props: Partial<{ refreshKey: number; switchEnabled: boolean; onSwitch: () => void }> = {}) {
  if (account instanceof Error) fetchAccount.mockRejectedValue(account);
  else fetchAccount.mockResolvedValue(account);
  const ui = (key: number) => <AccountBadge refreshKey={key} switchEnabled={props.switchEnabled ?? true} onSwitch={props.onSwitch ?? (() => undefined)} />;
  const view = render(ui(props.refreshKey ?? 0));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return { rerender: (key: number) => view.rerender(ui(key)) };
}

describe("AccountBadge", () => {
  it("K1: ログイン中は「Claude ログイン:」とメールとプランを出す", async () => {
    await show({ status: "ok", loggedIn: true, email: "who@example.com", subscriptionType: "max" });
    expect(screen.getByTestId("account-badge").textContent).toContain("Claude ログイン:");
    expect(screen.getByTestId("account-email").textContent).toBe("who@example.com");
    expect(screen.getByTestId("account-plan").textContent).toBe("max");
  });

  it("バッジに hint の title が付く", async () => {
    await show({ status: "ok", loggedIn: true, email: "a@b.c", subscriptionType: "max" });
    expect(screen.getByTestId("account-email").parentElement?.getAttribute("title")).toBe("この Mac に保存されたログインです。会話ごとの確認は /status で行います。");
  });

  it("K2: 未ログイン・invalid・error・取得失敗は空白にならず文言を出す", async () => {
    await show({ status: "ok", loggedIn: false });
    expect(screen.getByTestId("account-message").textContent).toBe("Claude: 未ログイン");
    cleanup();
    await show({ status: "invalid" });
    expect(screen.getByTestId("account-message").textContent).toBe("Claude: アカウントを確認できません");
    cleanup();
    await show({ status: "error" });
    expect(screen.getByTestId("account-message").textContent).toBe("Claude: アカウントを確認できません");
    cleanup();
    await show(new Error("x"));
    expect(screen.getByTestId("account-message").textContent).toBe("Claude: アカウントを確認できません");
  });

  it("60 秒ごとに取り直す。refreshKey が増えたら今すぐ取り直す", async () => {
    const { rerender } = await show({ status: "ok", loggedIn: true, email: "a@b.c", subscriptionType: "max" });
    expect(fetchAccount).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS);
    });
    expect(fetchAccount).toHaveBeenCalledTimes(2);
    fetchAccount.mockResolvedValue({ status: "ok", loggedIn: true, email: "new@example.com", subscriptionType: "pro" });
    rerender(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchAccount).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("account-email").textContent).toBe("new@example.com");
  });

  it("切り替えボタンは switchEnabled のときだけ出て、押すと onSwitch が呼ばれる", async () => {
    const onSwitch = vi.fn();
    await show({ status: "ok", loggedIn: false }, { onSwitch });
    fireEvent.click(screen.getByRole("button", { name: "アカウントを切り替える" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    cleanup();
    await show({ status: "ok", loggedIn: false }, { switchEnabled: false });
    expect(screen.queryByTestId("account-switch")).toBeNull();
  });
});
