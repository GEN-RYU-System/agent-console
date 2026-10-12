// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { PrResponse } from "../../types";

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const fetchPr = vi.fn();
const refreshPr = vi.fn();
vi.mock("../../api", () => ({
  ApiError: FakeApiError,
  fetchPr: (id: string) => fetchPr(id),
  refreshPr: (id: string) => refreshPr(id),
}));

const { PrPane } = await import("./PrPane");

const OK: PrResponse = {
  status: "ok",
  pr: { number: 12, title: "feat: PR を見る", state: "OPEN", isDraft: false, url: "https://github.com/example/repo/pull/12", mergeStateStatus: "CLEAN" },
  checks: {
    counts: { pass: 30, fail: 2, pending: 1, skipping: 8, cancel: 1 },
    items: [
      { name: "unit (ubuntu)", bucket: "fail", link: "https://github.com/example/repo/actions/runs/1", workflow: "ci" },
      { name: "lint", bucket: "fail", link: "", workflow: "ci" },
      { name: "e2e", bucket: "cancel", link: "https://github.com/example/repo/actions/runs/2", workflow: "ci" },
      { name: "build", bucket: "pending", link: "javascript:alert(1)", workflow: "ci" },
    ],
  },
  fetchedAt: Date.UTC(2026, 9, 12, 3, 4, 5),
};

function renderPane(over: Partial<{ sessionId: string; active: boolean }> = {}) {
  return render(<PrPane sessionId="s1" active {...over} />);
}

beforeEach(() => {
  fetchPr.mockReset();
  refreshPr.mockReset();
});

describe("PrPane の表示 (K1, K2)", () => {
  it("#番号 題名 をリンクにし、状態の Badge・マージできるか・5 つの集計を出す", async () => {
    fetchPr.mockResolvedValue(OK);
    renderPane();
    const link = await screen.findByRole("link", { name: /#12/ });
    expect(link.getAttribute("href")).toBe("https://github.com/example/repo/pull/12");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("feat: PR を見る");
    expect(screen.getByTestId("pr-state").textContent).toBe("オープン");
    expect(screen.getByTestId("pr-merge").textContent).toBe("マージできます");
    const counts = screen.getByTestId("pr-counts");
    expect(within(counts).getByText(/成功/).textContent).toContain("30");
    expect(within(counts).getByText(/失敗/).textContent).toContain("2");
    expect(within(counts).getByText(/実行中/).textContent).toContain("1");
    expect(within(counts).getByText(/スキップ/).textContent).toContain("8");
    expect(within(counts).getByText(/取り消し/).textContent).toContain("1");
  });

  it("失敗・取り消し・実行中の検査を 1 件ずつ出し、リンクがあるものだけ「開く」を出す（github.com 以外はリンクにしない: K8）", async () => {
    fetchPr.mockResolvedValue(OK);
    renderPane();
    const rows = await screen.findAllByTestId("pr-check");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText("unit (ubuntu)")).toBeTruthy();
    expect(within(rows[0]).getByRole("link", { name: /開く/ }).getAttribute("href")).toBe("https://github.com/example/repo/actions/runs/1");
    expect(within(rows[1]).queryByRole("link")).toBeNull();
    expect(within(rows[3]).queryByRole("link")).toBeNull(); // javascript: は画面でも弾く
  });

  it("PR の url が github.com でなければ、題名は文字だけでリンクにしない（K8）", async () => {
    fetchPr.mockResolvedValue({ ...OK, pr: { ...OK.pr, url: "https://evil.example/x" } });
    renderPane();
    await screen.findByTestId("pr-state");
    expect(screen.queryByRole("link", { name: /#12/ })).toBeNull();
    expect(screen.getByText(/#12/)).toBeTruthy();
  });

  it("状態の表示: 下書き / マージ済み / クローズ", async () => {
    for (const [pr, label] of [
      [{ ...OK.pr, isDraft: true }, "下書き"],
      [{ ...OK.pr, state: "MERGED" }, "マージ済み"],
      [{ ...OK.pr, state: "CLOSED" }, "クローズ"],
    ] as const) {
      fetchPr.mockResolvedValue({ ...OK, pr });
      const { unmount } = renderPane();
      await waitFor(() => expect(screen.getByTestId("pr-state").textContent).toBe(label));
      unmount();
    }
  });

  it("マージできるかの文言は mergeStateStatus ごとに決まり、未知の値は「確認中です」。open 以外では出さない", async () => {
    const expected: Record<string, string> = {
      CLEAN: "マージできます",
      HAS_HOOKS: "マージできます",
      UNSTABLE: "検査が終わっていないか、失敗がありますが、マージは可能です",
      BLOCKED: "条件を満たしていないためマージできません",
      BEHIND: "main より古いため更新が必要です",
      DIRTY: "競合があります",
      DRAFT: "下書きです",
      UNKNOWN: "確認中です",
      SOMETHING_NEW: "確認中です",
    };
    for (const [status, text] of Object.entries(expected)) {
      fetchPr.mockResolvedValue({ ...OK, pr: { ...OK.pr, mergeStateStatus: status } });
      const { unmount } = renderPane();
      await waitFor(() => expect(screen.getByTestId("pr-merge").textContent, status).toBe(text));
      unmount();
    }
    fetchPr.mockResolvedValue({ ...OK, pr: { ...OK.pr, state: "MERGED", mergeStateStatus: "UNKNOWN" } });
    renderPane();
    await screen.findByTestId("pr-state");
    expect(screen.queryByTestId("pr-merge")).toBeNull();
  });

  it("検査が 1 件も無い PR は、集計の代わりに「検査はありません」と出す", async () => {
    fetchPr.mockResolvedValue({ ...OK, checks: { counts: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 }, items: [] } });
    renderPane();
    expect(await screen.findByText("検査はありません")).toBeTruthy();
    expect(screen.queryByTestId("pr-counts")).toBeNull();
  });
});

describe("PrPane の状態ごとの文言 (K4, K6)", () => {
  const cases: Array<[PrResponse["status"], string]> = [
    ["loading", "確認中です"],
    ["noPr", "このブランチの PR はありません"],
    ["notGitHub", "GitHub のリポジトリではありません"],
    ["detached", "ブランチにいないため PR を確認できません"],
    ["ghMissing", "GitHub の状態を取得できませんでした"],
    ["authRequired", "GitHub の認証が切れています。ターミナルで gh auth login を実行してください"],
    ["timeout", "GitHub の状態を取得できませんでした"],
    ["rateLimited", "GitHub の状態を取得できませんでした"],
    ["ghFailed", "GitHub の状態を取得できませんでした"],
  ];
  for (const [status, text] of cases) {
    it(`${status} -> ${text}`, async () => {
      fetchPr.mockResolvedValue({ status });
      renderPane();
      await waitFor(() => expect(screen.getByTestId("pr-message").textContent).toContain(text));
    });
  }

  it("認証切れ以外の失敗は、理由の種類を添える", async () => {
    fetchPr.mockResolvedValue({ status: "ghMissing" });
    renderPane();
    await waitFor(() => expect(screen.getByTestId("pr-message").textContent).toContain("gh コマンドが見つかりません"));
  });

  it("作業場所が対象外（409）のときは「確認できません」、その他の API 失敗は取得できなかったと出す", async () => {
    fetchPr.mockRejectedValue(new FakeApiError("working directory is outside", 409));
    const { unmount } = renderPane();
    await waitFor(() => expect(screen.getByTestId("pr-message").textContent).toContain("この作業場所の PR は確認できません"));
    unmount();
    fetchPr.mockRejectedValue(new FakeApiError("boom", 500));
    renderPane();
    await waitFor(() => expect(screen.getByTestId("pr-message").textContent).toContain("GitHub の状態を取得できませんでした"));
  });
});

describe("PrPane の更新と取得のタイミング (K5)", () => {
  it("「更新」で refresh を呼び、返った結果に差し替える", async () => {
    fetchPr.mockResolvedValue({ status: "noPr" });
    renderPane();
    await screen.findByText("このブランチの PR はありません");
    refreshPr.mockResolvedValue(OK);
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    await screen.findByTestId("pr-state");
    expect(refreshPr).toHaveBeenCalledWith("s1");
  });

  it("タブが開いていない間は取得しない。開いたら取得する。セッションが変わったら取り直す", async () => {
    fetchPr.mockResolvedValue(OK);
    const { rerender } = render(<PrPane sessionId="s1" active={false} />);
    expect(fetchPr).not.toHaveBeenCalled();
    rerender(<PrPane sessionId="s1" active />);
    await screen.findByTestId("pr-state");
    expect(fetchPr).toHaveBeenCalledTimes(1);
    rerender(<PrPane sessionId="s2" active />);
    await waitFor(() => expect(fetchPr).toHaveBeenCalledWith("s2"));
  });
});
