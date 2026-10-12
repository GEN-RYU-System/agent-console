// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { PickItem } from "../../types";

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const fetchPicks = vi.fn();
const fetchPickImage = vi.fn();
const updatePickNote = vi.fn();
const deletePick = vi.fn();
const checkPicksSend = vi.fn();
const markPicksSent = vi.fn();
vi.mock("../../api", () => ({
  ApiError: FakeApiError,
  fetchPicks: () => fetchPicks(),
  fetchPickImage: (id: string) => fetchPickImage(id),
  updatePickNote: (id: string, note: string) => updatePickNote(id, note),
  deletePick: (id: string) => deletePick(id),
  checkPicksSend: (sid: string, ids: string[]) => checkPicksSend(sid, ids),
  markPicksSent: (ids: string[]) => markPicksSent(ids),
}));

const { PicksPane } = await import("./PicksPane");

const A = "0b6f1c0e-5d2a-4b7e-9a31-8c2f4d1e7a90";
const B = "1c7a2d1f-6e3b-4c8f-8b42-9d3a5e2f8ba1";
const EXT_DIR = "/Users/x/App Data/agent-console/chrome-extension";

function pick(id: string, over: Partial<PickItem> = {}): PickItem {
  return {
    id,
    createdAt: Date.UTC(2026, 9, 12, 3, 4, 5),
    url: "https://reference.example/page?q=1",
    title: "参考ページ",
    selector: "#root > p",
    tag: "p",
    attrs: { id: "x" },
    text: "ここの文字",
    html: '<p id="x">ここの文字</p>',
    style: { "font-size": "14px", color: "inherit" },
    rect: { x: 1, y: 2, w: 3, h: 4 },
    dpr: 1,
    vw: 1000,
    hasImage: true,
    imageError: "",
    note: "",
    ...over,
  };
}

const idle = { state: "idle" as const, canInput: true };
function renderPane(over: Record<string, unknown> = {}) {
  const paste = vi.fn().mockResolvedValue("sent");
  const utils = render(<PicksPane sessionId="s1" active unsent={2} {...idle} paste={paste} {...over} />);
  return { paste, ...utils };
}

beforeEach(() => {
  for (const m of [fetchPicks, fetchPickImage, updatePickNote, deletePick, checkPicksSend, markPicksSent]) m.mockReset();
  fetchPickImage.mockResolvedValue("data:image/png;base64,AAAA");
  markPicksSent.mockResolvedValue({ marked: true });
  fetchPicks.mockResolvedValue({ items: [pick(A), pick(B, { hasImage: false, imageError: "image is too large", title: "二つ目" })], extensionDir: EXT_DIR });
});

describe("PicksPane の一覧 (K3)", () => {
  it("各部品に、画像（data: URL）・URL のホスト名・文字の先頭を出し、画像が無いものは理由を出す", async () => {
    renderPane();
    const cards = await screen.findAllByTestId("pick-item");
    expect(cards).toHaveLength(2);
    const first = within(cards[0]);
    const img = await first.findByRole("img");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(first.getByText("reference.example")).toBeTruthy();
    expect(first.getByText("ここの文字")).toBeTruthy();
    expect(within(cards[1]).queryByRole("img")).toBeNull();
    expect(within(cards[1]).getByText("画像なし（image is too large）")).toBeTruthy();
    expect(fetchPickImage).toHaveBeenCalledTimes(1);
    expect(fetchPickImage).toHaveBeenCalledWith(A);
  });

  it("文字と HTML は React のテキストとして出し、HTML として解釈しない", async () => {
    fetchPicks.mockResolvedValue({ items: [pick(A, { text: "<img src=x onerror=alert(1)>", html: "<script>alert(1)</script>", title: "<b>t</b>" })], extensionDir: EXT_DIR });
    const { container } = renderPane();
    const card = await screen.findByTestId("pick-item");
    fireEvent.click(within(card).getByRole("button", { name: "内容を見る" }));
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(card.textContent).toContain("<script>alert(1)</script>");
    expect(card.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("[dangerouslysetinnerhtml]")).toBeNull();
  });

  it("見た目の値・属性・セレクタ・HTML は、「内容を見る」を押すまで折りたたまれている", async () => {
    renderPane();
    const card = (await screen.findAllByTestId("pick-item"))[0];
    expect(within(card).queryByText(/font-size/)).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "内容を見る" }));
    expect(within(card).getByText(/font-size/).textContent).toContain("14px");
    expect(within(card).getByText("#root > p")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "内容を閉じる" }));
    expect(within(card).queryByText(/font-size/)).toBeNull();
  });

  it("0 件のときは EmptyState に、拡張の読み込み手順と、サーバーが返した実際のフォルダの場所を出す", async () => {
    fetchPicks.mockResolvedValue({ items: [], extensionDir: EXT_DIR });
    renderPane({ unsent: 0 });
    expect(await screen.findByText("まだ部品が届いていません")).toBeTruthy();
    expect(screen.getByText(EXT_DIR)).toBeTruthy();
    expect(screen.getByText(/デベロッパー モード/)).toBeTruthy();
  });

  it("取得に失敗したときは警告を出す", async () => {
    fetchPicks.mockRejectedValue(new FakeApiError("x", 500));
    renderPane();
    expect(await screen.findByText("部品を取得できませんでした")).toBeTruthy();
  });

  it("隠れている間（active=false）は取得しない。件数が変わったら、開いたときに取り直す", async () => {
    const { rerender, paste } = renderPane({ active: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchPicks).not.toHaveBeenCalled();
    rerender(<PicksPane sessionId="s1" active unsent={2} {...idle} paste={paste} />);
    await screen.findAllByTestId("pick-item");
    expect(fetchPicks).toHaveBeenCalledTimes(1);
    rerender(<PicksPane sessionId="s1" active unsent={3} {...idle} paste={paste} />);
    await waitFor(() => expect(fetchPicks).toHaveBeenCalledTimes(2));
  });
});

describe("PicksPane: ひとこと・選ぶ・削除 (K3)", () => {
  it("ひとことを書いて欄を離れると保存する（変わっていなければ保存しない）", async () => {
    updatePickNote.mockResolvedValue(pick(A, { note: "ここを青に" }));
    renderPane();
    const card = (await screen.findAllByTestId("pick-item"))[0];
    const box = within(card).getByLabelText("ひとこと（Claude への指示）");
    fireEvent.blur(box);
    expect(updatePickNote).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "ここを青に" } });
    fireEvent.blur(box);
    await waitFor(() => expect(updatePickNote).toHaveBeenCalledWith(A, "ここを青に"));
  });

  it("選ぶ切り替えは Button の aria-pressed で、未送信の部品は最初から選ばれている", async () => {
    renderPane();
    const cards = await screen.findAllByTestId("pick-item");
    const toggle = within(cards[0]).getByRole("button", { name: "選んでいる" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(within(cards[0]).getByRole("button", { name: "選ぶ" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Claude に送る（1件）" })).toBeTruthy();
  });

  it("送信済みの部品は最初から選ばれておらず、「送信済み」の印が付く", async () => {
    fetchPicks.mockResolvedValue({ items: [pick(A, { sentAt: 5 }), pick(B)], extensionDir: EXT_DIR });
    renderPane();
    const cards = await screen.findAllByTestId("pick-item");
    expect(within(cards[0]).getByText("送信済み")).toBeTruthy();
    expect(within(cards[0]).getByRole("button", { name: "選ぶ" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(cards[1]).queryByText("送信済み")).toBeNull();
  });

  it("削除は一覧から外す。失敗したら警告を出して残す", async () => {
    deletePick.mockResolvedValueOnce({ removed: true }).mockRejectedValueOnce(new FakeApiError("x", 500));
    renderPane();
    let cards = await screen.findAllByTestId("pick-item");
    fireEvent.click(within(cards[0]).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(screen.getAllByTestId("pick-item")).toHaveLength(1));
    cards = screen.getAllByTestId("pick-item");
    fireEvent.click(within(cards[0]).getByRole("button", { name: "削除" }));
    expect(await screen.findByText("削除できませんでした")).toBeTruthy();
    expect(screen.getAllByTestId("pick-item")).toHaveLength(1);
  });
});

describe("PicksPane: Claude に送る (K3, K7)", () => {
  it("書きかけのひとことを保存してから、選んだ部品の依頼文を作らせ、端末に貼り、貼れたら送信済みにする", async () => {
    updatePickNote.mockResolvedValue(pick(A));
    checkPicksSend.mockResolvedValue({ text: "依頼文", ids: [A, B], submitDelayMs: 2000 });
    const { paste } = renderPane();
    const cards = await screen.findAllByTestId("pick-item");
    fireEvent.change(within(cards[0]).getByLabelText("ひとこと（Claude への指示）"), { target: { value: "直して" } });
    fireEvent.click(screen.getByRole("button", { name: "Claude に送る（2件）" }));
    await waitFor(() => expect(markPicksSent).toHaveBeenCalledWith([A, B]));
    expect(updatePickNote).toHaveBeenCalledWith(A, "直して");
    expect(checkPicksSend).toHaveBeenCalledWith("s1", [A, B]);
    expect(paste).toHaveBeenCalledWith("s1", "依頼文", 2000);
    expect(updatePickNote.mock.invocationCallOrder[0]).toBeLessThan(checkPicksSend.mock.invocationCallOrder[0]);
    expect(checkPicksSend.mock.invocationCallOrder[0]).toBeLessThan(paste.mock.invocationCallOrder[0]);
    expect((await screen.findAllByText("送信済み")).length).toBe(2);
  });

  it("貼れなかった（切り替わった）ときは、送信済みにせず案内を出す", async () => {
    checkPicksSend.mockResolvedValue({ text: "x", ids: [A, B], submitDelayMs: 0 });
    const paste = vi.fn().mockResolvedValue("notPasted");
    renderPane({ paste });
    await screen.findAllByTestId("pick-item");
    fireEvent.click(screen.getByRole("button", { name: "Claude に送る（2件）" }));
    expect(await screen.findByText(/別のセッションへ切り替わったため、指示は入れませんでした/)).toBeTruthy();
    expect(markPicksSent).not.toHaveBeenCalled();
  });

  it("貼ったあとで切り替わったときは、送信済みにせず、Enter を送っていないと案内する", async () => {
    checkPicksSend.mockResolvedValue({ text: "x", ids: [A, B], submitDelayMs: 0 });
    const paste = vi.fn().mockResolvedValue("pastedNotSent");
    renderPane({ paste });
    await screen.findAllByTestId("pick-item");
    fireEvent.click(screen.getByRole("button", { name: "Claude に送る（2件）" }));
    expect(await screen.findByText(/Enter は送っていません/)).toBeTruthy();
    expect(markPicksSent).not.toHaveBeenCalled();
  });

  it("サーバーが断った（作業中・長すぎ）ときは、その理由を警告に出し、貼らない", async () => {
    checkPicksSend.mockRejectedValue(new FakeApiError("claude is busy", 409));
    const { paste } = renderPane();
    await screen.findAllByTestId("pick-item");
    fireEvent.click(screen.getByRole("button", { name: "Claude に送る（2件）" }));
    expect(await screen.findByText("claude is busy")).toBeTruthy();
    expect(paste).not.toHaveBeenCalled();
  });

  it.each([
    ["working", "Claude が作業中のため送れません"],
    ["waiting", "Claude が許可の確認を待っているため送れません"],
    ["stopped", "このセッションは止まっているため送れません"],
    ["unknown", "Claude の状態を確認できないため送れません"],
  ] as const)("K7: %s のときは押せず、理由を出す", async (state, reason) => {
    renderPane({ state, canInput: false });
    await screen.findAllByTestId("pick-item");
    expect((screen.getByRole("button", { name: "Claude に送る（2件）" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("picks-send-reason").textContent).toBe(reason);
  });

  it("セッションが無いとき・何も選んでいないときも押せず、理由を出す", async () => {
    const { rerender, paste } = renderPane({ sessionId: null });
    await screen.findAllByTestId("pick-item");
    expect(screen.getByTestId("picks-send-reason").textContent).toBe("送り先のセッションを選んでください");
    rerender(<PicksPane sessionId="s1" active unsent={2} {...idle} paste={paste} />);
    for (const t of screen.getAllByRole("button", { name: "選んでいる" })) fireEvent.click(t);
    expect(screen.getByTestId("picks-send-reason").textContent).toBe("送る部品を選んでください");
    expect((screen.getByRole("button", { name: "Claude に送る（0件）" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
