// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { ChatItem, ChatQueueItem, ChatResponse, QuickPrompt, SessionState } from "../../types";

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const fetchChat = vi.fn<(id: string, since: number, epoch: string | null) => Promise<ChatResponse>>();
const queueChat = vi.fn<(id: string, text: string) => Promise<{ id: string }>>();
const cancelChatQueue = vi.fn<(id: string, queueId: string) => Promise<{ ok: true }>>();
const updateQuickPrompt = vi.fn();
vi.mock("../../api", () => ({
  ApiError: FakeApiError,
  fetchChat: (id: string, since: number, epoch: string | null) => fetchChat(id, since, epoch),
  queueChat: (id: string, text: string) => queueChat(id, text),
  cancelChatQueue: (id: string, queueId: string) => cancelChatQueue(id, queueId),
  updateQuickPrompt: (id: string, i: unknown) => updateQuickPrompt(id, i),
}));

const { ChatPane } = await import("./ChatPane");

const onOpenTerminal = vi.fn();

const item = (seq: number, role: ChatItem["role"], text: string, over: Partial<ChatItem> = {}): ChatItem => ({ seq, ts: 1000 + seq, role, text, ...over });
const ok = (items: ChatItem[], over: Partial<Extract<ChatResponse, { status: "ok" }>> = {}): ChatResponse => ({ status: "ok", epoch: "e1", reset: false, lastSeq: items.at(-1)?.seq ?? 0, items, queued: [], ...over });
const queuedItem = (id: string, text: string, state: ChatQueueItem["state"] = "queued"): ChatQueueItem => ({ id, text, createdAt: 1, state });

const prompts: QuickPrompt[] = [
  { id: "p1", label: "テスト実行", text: "テストを実行して", pinned: true },
  { id: "p2", label: "リント", text: "lint を実行して", pinned: false },
];

type Props = React.ComponentProps<typeof ChatPane>;
function renderPane(over: Partial<Props> = {}) {
  const props: Props = {
    sessionId: "s1",
    active: true,
    rev: 0,
    state: "idle" as SessionState,
    canChat: true,
    prompts,
    onPromptsChanged: vi.fn(),
    onOpenTerminal,
    ...over,
  };
  const view = render(<ChatPane {...props} />);
  return { props, ...view, rerenderWith: (next: Partial<Props>) => view.rerender(<ChatPane {...props} {...next} />) };
}

beforeEach(() => {
  fetchChat.mockReset().mockResolvedValue(ok([]));
  queueChat.mockReset().mockResolvedValue({ id: "q1" });
  cancelChatQueue.mockReset().mockResolvedValue({ ok: true });
  onOpenTerminal.mockReset();
  updateQuickPrompt.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

const input = (): HTMLTextAreaElement => screen.getByTestId("chat-input") as HTMLTextAreaElement;
const sendButton = (): HTMLButtonElement => screen.getByRole("button", { name: "送る" }) as HTMLButtonElement;
const type = (text: string): void => void fireEvent.change(input(), { target: { value: text } });

describe("K2 会話の表示", () => {
  it("古い順に並べ、しんごさんの文章は右寄せ（user）、Claude の返事は左寄せ（assistant）の吹き出しで出す", async () => {
    fetchChat.mockResolvedValue(ok([item(1, "user", "質問です"), item(2, "assistant", "答えです")]));
    renderPane();
    const bubbles = await screen.findAllByTestId("chat-bubble");
    expect(bubbles.map((b) => [b.getAttribute("data-role"), b.textContent])).toEqual([
      ["user", "質問です"],
      ["assistant", "答えです"],
    ]);
    expect(bubbles[0].className).toContain("ac-chat__bubble--user");
    expect(bubbles[1].className).toContain("ac-chat__bubble--assistant");
    expect(bubbles[0].closest("[data-testid='chat-row']")?.className).toContain("ac-chat__row--user");
    expect(bubbles[1].closest("[data-testid='chat-row']")?.className).toContain("ac-chat__row--assistant");
  });

  it("しんごさんの文章は、そのままの文字で出す（HTML も Markdown も効かせず、改行は残す）", async () => {
    fetchChat.mockResolvedValue(ok([item(1, "user", "# 見出しではない\n<b>太字ではない</b>")]));
    renderPane();
    const bubble = await screen.findByTestId("chat-bubble");
    expect(bubble.querySelector("h1, b")).toBeNull();
    expect(bubble.textContent).toBe("# 見出しではない\n<b>太字ではない</b>");
  });

  it("K4 Claude の返事は Markdown として描画する", async () => {
    fetchChat.mockResolvedValue(ok([item(1, "assistant", "## 見出し\n\n- 一つ目\n- **二つ目**")]));
    renderPane();
    const bubble = await screen.findByTestId("chat-bubble");
    expect(bubble.querySelector("h2")?.textContent).toBe("見出し");
    expect(bubble.querySelectorAll("li")).toHaveLength(2);
    expect(bubble.querySelector("strong")?.textContent).toBe("二つ目");
  });

  it("K8 切り詰められた返事の末尾に「（以下略）」を出す。切り詰められていない返事には出さない", async () => {
    fetchChat.mockResolvedValue(ok([item(1, "assistant", "長い返事の先頭", { truncated: true }), item(2, "assistant", "短い返事")]));
    renderPane();
    const bubbles = await screen.findAllByTestId("chat-bubble");
    expect(bubbles[0].textContent).toContain("（以下略）");
    expect(bubbles[1].textContent).not.toContain("（以下略）");
  });

  it("K3 API エラー（StopFailure）は、エラーの種類の短い案内として出す。知らない種類は「不明」の案内", async () => {
    fetchChat.mockResolvedValue(ok([item(1, "error", "", { error: "rate_limit" }), item(2, "error", "", { error: "something_new" })]));
    renderPane();
    const notices = await screen.findAllByTestId("chat-error");
    expect(notices[0].textContent).toContain("利用の上限");
    expect(notices[1].textContent).toContain("原因を特定できないエラー");
  });

  it("まだ会話が無い（記録が無い・claudeSessionId がまだ無い）ときは、案内を出す", async () => {
    fetchChat.mockResolvedValue({ status: "noSession", queued: [] });
    renderPane();
    expect(await screen.findByTestId("chat-empty")).toBeTruthy();
    cleanup();
    fetchChat.mockResolvedValue(ok([]));
    renderPane();
    expect(await screen.findByTestId("chat-empty")).toBeTruthy();
  });

  it("セッションを選んでいないときは、選ぶ案内を出し、取得も送信もしない", () => {
    renderPane({ sessionId: null });
    expect(screen.getByText("左の一覧からセッションを選んでください")).toBeTruthy();
    expect(fetchChat).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-input")).toBeNull();
  });
});

describe("会話の取り直し", () => {
  it("開いたときに全件（since=0）を取り、記録の版（rev）が進んだら、続きだけ（since=lastSeq・epoch つき）を取って足す", async () => {
    fetchChat.mockResolvedValueOnce(ok([item(1, "user", "一")], { lastSeq: 1 }));
    const { rerenderWith } = renderPane();
    await screen.findByText("一");
    expect(fetchChat).toHaveBeenLastCalledWith("s1", 0, null);
    fetchChat.mockResolvedValueOnce(ok([item(2, "assistant", "二")], { lastSeq: 2 }));
    rerenderWith({ rev: 1 });
    await screen.findByText("二");
    expect(fetchChat).toHaveBeenLastCalledWith("s1", 1, "e1");
    expect(screen.getAllByTestId("chat-bubble")).toHaveLength(2);
  });

  it("reset: true が来たら（アプリが作り直された）、これまでの表示を捨てて、来た全件にする", async () => {
    fetchChat.mockResolvedValueOnce(ok([item(1, "user", "古い表示")], { lastSeq: 1 }));
    const { rerenderWith } = renderPane();
    await screen.findByText("古い表示");
    fetchChat.mockResolvedValueOnce(ok([item(1, "user", "作り直し後")], { reset: true, epoch: "e2", lastSeq: 1 }));
    rerenderWith({ rev: 1 });
    await screen.findByText("作り直し後");
    expect(screen.queryByText("古い表示")).toBeNull();
  });

  it("タブが開いていない（active: false）間は取りに行かない。開いたら取る", async () => {
    const { rerenderWith } = renderPane({ active: false });
    await act(async () => undefined);
    expect(fetchChat).not.toHaveBeenCalled();
    fetchChat.mockResolvedValueOnce(ok([item(1, "user", "開いたあと")]));
    rerenderWith({ active: true });
    await screen.findByText("開いたあと");
  });

  it("取得に失敗したら、案内を出す（会話の表示は消さない）", async () => {
    fetchChat.mockResolvedValueOnce(ok([item(1, "user", "残る")]));
    const { rerenderWith } = renderPane();
    await screen.findByText("残る");
    fetchChat.mockRejectedValueOnce(new Error("boom"));
    rerenderWith({ rev: 1 });
    expect(await screen.findByTestId("chat-load-error")).toBeTruthy();
    expect(screen.getByText("残る")).toBeTruthy();
  });
});

describe("K1 入力欄と送る（いつでも予約に入れるだけ）", () => {
  it("Enter で予約に入れ、入力欄を空にして、予約を取り直す。端末への貼り付けはしない", async () => {
    renderPane();
    await screen.findByTestId("chat-empty");
    fetchChat.mockResolvedValueOnce(ok([], { queued: [queuedItem("q1", "こんにちは\n二行目")] }));
    type("こんにちは\n二行目");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(queueChat).toHaveBeenCalledWith("s1", "こんにちは\n二行目"));
    await waitFor(() => expect(input().value).toBe(""));
    expect((await screen.findByTestId("chat-queue-item")).textContent).toContain("こんにちは\n二行目");
  });

  it("「送る」ボタンでも同じように予約に入れる。空（空白だけ）のときは押せない", async () => {
    renderPane();
    expect(sendButton().disabled).toBe(true);
    type("   \n ");
    expect(sendButton().disabled).toBe(true);
    type("送ります");
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await waitFor(() => expect(queueChat).toHaveBeenCalledWith("s1", "送ります"));
  });

  it("Shift+Enter では送らない（改行になる）", async () => {
    renderPane();
    type("書きかけ");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13, shiftKey: true });
    await act(async () => undefined);
    expect(queueChat).not.toHaveBeenCalled();
    expect(input().value).toBe("書きかけ");
  });

  it("日本語の変換中の Enter（isComposing、または keyCode 229）では送らない", async () => {
    renderPane();
    type("へんかん");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13, isComposing: true });
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    await act(async () => undefined);
    expect(queueChat).not.toHaveBeenCalled();
  });

  it("予約に入れられなかった（検査で断られた・上限）ときは、理由を出し、入力欄の文章は残す", async () => {
    queueChat.mockRejectedValueOnce(new FakeApiError("text must not be empty", 400));
    renderPane();
    type("残したい文章");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    expect((await screen.findByTestId("chat-send-error")).textContent).toContain("text must not be empty");
    expect(input().value).toBe("残したい文章");
  });

  it("K6 予約がいっぱい（409 queue is full）のときは、上限を伝える案内を出す", async () => {
    queueChat.mockRejectedValueOnce(new FakeApiError("chat queue is full (max 10)", 409));
    renderPane();
    type("あふれる");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    expect((await screen.findByTestId("chat-send-error")).textContent).toContain("予約がいっぱいです（最大 10 件）");
    expect(input().value).toBe("あふれる");
  });

  it("送っている間は二重に送らない", async () => {
    let release: (v: { id: string }) => void = () => undefined;
    queueChat.mockReturnValueOnce(new Promise<{ id: string }>((resolve) => (release = resolve)));
    renderPane();
    type("一回だけ");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(queueChat).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    expect(sendButton().disabled).toBe(true);
    await act(async () => release({ id: "q1" }));
    expect(queueChat).toHaveBeenCalledTimes(1);
  });
});

describe("K7 予約の表示（会話の一番下・送る順・3 段）", () => {
  it("予約中・送信済みを送る順に、会話の一番下に出す。それぞれ印（予約中／送信済み）が付き、上に再起動で消える旨の文を出す", async () => {
    fetchChat.mockResolvedValue(ok([item(1, "assistant", "返事")], { queued: [queuedItem("a", "先に送った", "sent"), queuedItem("b", "次に送る")] }));
    renderPane();
    const rows = await screen.findAllByTestId("chat-queue-item");
    expect(rows.map((r) => [r.getAttribute("data-state"), r.textContent])).toEqual([
      ["sent", expect.stringContaining("先に送った")],
      ["queued", expect.stringContaining("次に送る")],
    ]);
    expect(rows[0].textContent).toContain("送信済み（受け取り待ち）");
    expect(rows[1].textContent).toContain("予約中（確認が終わったら送ります）");
    expect(screen.getByTestId("chat-queue-note").textContent).toContain("アプリを再起動すると予約は消えます");
    // 会話の後ろに並ぶ
    const list = screen.getByTestId("chat-list");
    const order = [...list.querySelectorAll("[data-testid='chat-row'], [data-testid='chat-queue-item']")].map((e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["chat-row", "chat-queue-item", "chat-queue-item"]);
  });

  it("予約が無いときは、文も印も出ない。noSession（記録がまだ無い）でも予約は出る", async () => {
    renderPane();
    await screen.findByTestId("chat-empty");
    expect(screen.queryByTestId("chat-queue-note")).toBeNull();
    cleanup();
    fetchChat.mockResolvedValue({ status: "noSession", queued: [queuedItem("a", "記録の前の予約")] });
    renderPane();
    expect((await screen.findByTestId("chat-queue-item")).textContent).toContain("記録の前の予約");
  });

  it("予約が届いて会話に出たら（版が進んで予約が外れたら）、予約の表示は消える", async () => {
    fetchChat.mockResolvedValueOnce(ok([], { queued: [queuedItem("a", "届く文", "sent")] }));
    const { rerenderWith } = renderPane();
    await screen.findByTestId("chat-queue-item");
    fetchChat.mockResolvedValueOnce(ok([item(1, "user", "届く文")], { lastSeq: 1, queued: [] }));
    rerenderWith({ rev: 1 });
    await waitFor(() => expect(screen.queryByTestId("chat-queue-item")).toBeNull());
    expect(screen.getByText("届く文")).toBeTruthy();
  });

  it("K4 予約中の「取り消す」を押すと取り消し、予約を取り直す", async () => {
    fetchChat.mockResolvedValueOnce(ok([], { queued: [queuedItem("a", "消す")] }));
    renderPane();
    const row = await screen.findByTestId("chat-queue-item");
    fetchChat.mockResolvedValueOnce(ok([], { queued: [] }));
    fireEvent.click(within(row).getByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(cancelChatQueue).toHaveBeenCalledWith("s1", "a"));
    await waitFor(() => expect(screen.queryByTestId("chat-queue-item")).toBeNull());
  });

  it("M-c 送信済みの予約にも消すボタンがある（「受け取りを確認できませんでした。消しますか」）", async () => {
    fetchChat.mockResolvedValueOnce(ok([], { queued: [queuedItem("a", "受け取られない", "sent")] }));
    renderPane();
    const row = await screen.findByTestId("chat-queue-item");
    fetchChat.mockResolvedValueOnce(ok([], { queued: [] }));
    fireEvent.click(within(row).getByRole("button", { name: "受け取りを確認できませんでした。消しますか" }));
    await waitFor(() => expect(cancelChatQueue).toHaveBeenCalledWith("s1", "a"));
  });
});

describe("K8 状態ごとの扱い", () => {
  it.each([
    ["working", "Claude が作業中です。送った文章は予約され、作業が終わってから届きます"],
    ["unknown", "Claude の状態を確認できません。送った文章は予約され、確認できたら届きます"],
  ] as const)("%s のとき（canChat:false）も「送る」を押せる（予約になる）。案内の文を出す", async (state, notice) => {
    renderPane({ state, canChat: false });
    type("作業中に送る");
    expect(sendButton().disabled).toBe(false);
    expect(screen.getByTestId("chat-blocked").textContent).toContain(notice);
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(queueChat).toHaveBeenCalledWith("s1", "作業中に送る"));
  });

  it("working でも canChat:true（作業中で待ちなし）なら予約の案内は出ない。「送る」は押せる", async () => {
    renderPane({ state: "working", canChat: true });
    type("作業中にすぐ送る");
    expect(sendButton().disabled).toBe(false);
    expect(screen.queryByTestId("chat-blocked")).toBeNull();
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(queueChat).toHaveBeenCalledWith("s1", "作業中にすぐ送る"));
  });

  it("stopped のときは「送る」を押せず、理由の文を出す。Enter でも送らない。入力欄には書ける", async () => {
    renderPane({ state: "stopped", canChat: false });
    type("送りたい");
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByTestId("chat-blocked").textContent).toContain("このセッションは停止しているため送れません");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    await act(async () => undefined);
    expect(queueChat).not.toHaveBeenCalled();
    expect(input().value).toBe("送りたい");
  });

  it("確認の待ち（waiting）のときは「端末で確認が出ています」と端末タブへ移るボタンを出したまま、予約もできる", async () => {
    renderPane({ state: "waiting", canChat: false });
    expect(screen.getByTestId("chat-blocked").textContent).toContain("端末で確認が出ています");
    fireEvent.click(within(screen.getByTestId("chat-blocked")).getByRole("button", { name: "端末を開く" }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    type("確認の間に予約");
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await waitFor(() => expect(queueChat).toHaveBeenCalledWith("s1", "確認の間に予約"));
  });

  it("手すきのときは案内も端末を開くボタンも出ない", () => {
    renderPane();
    expect(screen.queryByTestId("chat-blocked")).toBeNull();
  });
});

describe("K7 よく使う指示", () => {
  it("タブが開いていない（active: false）間は、バーを DOM に置かない（端末の上のバーと 2 本並ばない）", () => {
    renderPane({ active: false });
    expect(screen.queryByTestId("quick-prompt-bar")).toBeNull();
  });

  it("常に表示の指示を並べる。押すと本文が入力欄に入る（すぐには送らない）", async () => {
    renderPane();
    const bar = screen.getByTestId("quick-prompt-bar");
    expect(within(bar).getByRole("button", { name: "テスト実行" })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: "リント" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "テスト実行" }));
    expect(input().value).toBe("テストを実行して");
    await act(async () => undefined);
    expect(queueChat).not.toHaveBeenCalled();
  });

  it("入力欄にすでに文章があるときは、改行を 1 つ挟んで後ろに足す", () => {
    renderPane();
    type("先に書いた文");
    fireEvent.click(within(screen.getByTestId("quick-prompt-bar")).getByRole("button", { name: "テスト実行" }));
    expect(input().value).toBe("先に書いた文\nテストを実行して");
  });

  it("送れない状態でも押せる（入力欄に入れるだけなので）", () => {
    renderPane({ state: "working", canChat: false });
    const button = within(screen.getByTestId("quick-prompt-bar")).getByRole("button", { name: "テスト実行" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(input().value).toBe("テストを実行して");
  });

  it("一覧（全件）の「使う」でも、本文が入力欄に入る", async () => {
    renderPane();
    fireEvent.click(within(screen.getByTestId("quick-prompt-bar")).getByRole("button", { name: "よく使う指示" }));
    const row = screen.getAllByTestId("quick-prompt-item")[1];
    fireEvent.click(within(row).getByRole("button", { name: "使う" }));
    expect(input().value).toBe("lint を実行して");
  });
});
