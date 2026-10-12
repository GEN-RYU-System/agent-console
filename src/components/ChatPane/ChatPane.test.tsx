// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { ChatItem, ChatResponse, QuickPrompt, SessionState } from "../../types";

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const fetchChat = vi.fn<(id: string, since: number, epoch: string | null) => Promise<ChatResponse>>();
const checkChatSend = vi.fn<(id: string, text: string) => Promise<{ text: string; submitDelayMs: number }>>();
const updateQuickPrompt = vi.fn();
vi.mock("../../api", () => ({
  ApiError: FakeApiError,
  fetchChat: (id: string, since: number, epoch: string | null) => fetchChat(id, since, epoch),
  checkChatSend: (id: string, text: string) => checkChatSend(id, text),
  updateQuickPrompt: (id: string, i: unknown) => updateQuickPrompt(id, i),
}));

const { ChatPane } = await import("./ChatPane");

type PasteResult = "sent" | "notPasted" | "pastedNotSent";
const paste = vi.fn<(id: string, text: string, delayMs: number) => Promise<PasteResult>>();
const onOpenTerminal = vi.fn();

const item = (seq: number, role: ChatItem["role"], text: string, over: Partial<ChatItem> = {}): ChatItem => ({ seq, ts: 1000 + seq, role, text, ...over });
const ok = (items: ChatItem[], over: Partial<Extract<ChatResponse, { status: "ok" }>> = {}): ChatResponse => ({ status: "ok", epoch: "e1", reset: false, lastSeq: items.at(-1)?.seq ?? 0, items, ...over });

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
    canInput: true,
    paste,
    prompts,
    onEditPrompts: vi.fn(),
    onPromptsChanged: vi.fn(),
    onOpenTerminal,
    ...over,
  };
  const view = render(<ChatPane {...props} />);
  return { props, ...view, rerenderWith: (next: Partial<Props>) => view.rerender(<ChatPane {...props} {...next} />) };
}

beforeEach(() => {
  fetchChat.mockReset().mockResolvedValue(ok([]));
  checkChatSend.mockReset().mockImplementation(async (_id, text) => ({ text, submitDelayMs: 2000 }));
  paste.mockReset().mockResolvedValue("sent");
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
    fetchChat.mockResolvedValue({ status: "noSession" });
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

describe("K5 入力欄と送る", () => {
  it("Enter で、送る前の確認 → 端末へ貼る（待ち時間つき）の順に進み、入力欄を空にして「送りました」を出す", async () => {
    renderPane();
    type("こんにちは\n二行目");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(paste).toHaveBeenCalledWith("s1", "こんにちは\n二行目", 2000));
    expect(checkChatSend).toHaveBeenCalledWith("s1", "こんにちは\n二行目");
    await waitFor(() => expect(input().value).toBe(""));
    expect(screen.getByTestId("chat-sent-notice").textContent).toBe("送りました（Claude が受け取ると表示されます）");
  });

  it("「送る」ボタンでも同じように送る。空（空白だけ）のときは押せない", async () => {
    renderPane();
    expect(sendButton().disabled).toBe(true);
    type("   \n ");
    expect(sendButton().disabled).toBe(true);
    type("送ります");
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await waitFor(() => expect(paste).toHaveBeenCalledWith("s1", "送ります", 2000));
  });

  it("Shift+Enter では送らない（改行になる）", async () => {
    renderPane();
    type("書きかけ");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13, shiftKey: true });
    await act(async () => undefined);
    expect(checkChatSend).not.toHaveBeenCalled();
    expect(input().value).toBe("書きかけ");
  });

  it("日本語の変換中の Enter（isComposing、または keyCode 229）では送らない", async () => {
    renderPane();
    type("へんかん");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13, isComposing: true });
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    await act(async () => undefined);
    expect(checkChatSend).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();
  });

  it("送った文章が会話に届いたら（新しい user の記録が来たら）、「送りました」を消す", async () => {
    fetchChat.mockResolvedValueOnce(ok([item(1, "assistant", "前の返事")], { lastSeq: 1 }));
    const { rerenderWith } = renderPane();
    await screen.findByText("前の返事");
    type("送る文");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    await screen.findByTestId("chat-sent-notice");
    // user ではない記録が来ても消えない
    fetchChat.mockResolvedValueOnce(ok([item(2, "assistant", "別の返事")], { lastSeq: 2 }));
    rerenderWith({ rev: 1 });
    await screen.findByText("別の返事");
    expect(screen.getByTestId("chat-sent-notice")).toBeTruthy();
    fetchChat.mockResolvedValueOnce(ok([item(3, "user", "送る文")], { lastSeq: 3 }));
    rerenderWith({ rev: 2 });
    await waitFor(() => expect(screen.queryByTestId("chat-sent-notice")).toBeNull());
  });

  it("送る前の確認が断られた（409 など）ときは、理由を出し、入力欄の文章は残す。端末へは貼らない", async () => {
    checkChatSend.mockRejectedValueOnce(new FakeApiError("claude is busy", 409));
    renderPane();
    type("残したい文章");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    expect(await screen.findByTestId("chat-send-error")).toBeTruthy();
    expect(screen.getByTestId("chat-send-error").textContent).toContain("claude is busy");
    expect(input().value).toBe("残したい文章");
    expect(paste).not.toHaveBeenCalled();
  });

  it("貼る前に別のセッションへ切り替わった（notPasted）ときは、案内を出し、文章は残す", async () => {
    paste.mockResolvedValueOnce("notPasted");
    renderPane();
    type("切り替わった");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    expect((await screen.findByTestId("chat-send-error")).textContent).toContain("切り替わった");
    expect(input().value).toBe("切り替わった");
  });

  it("貼ったあと Enter の前に切り替わった（pastedNotSent）ときは、端末で Enter を押す案内を出す", async () => {
    paste.mockResolvedValueOnce("pastedNotSent");
    renderPane();
    type("貼っただけ");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    expect((await screen.findByTestId("chat-send-error")).textContent).toContain("Enter を押してください");
    expect(screen.queryByTestId("chat-sent-notice")).toBeNull();
  });

  it("送っている間は二重に送らない", async () => {
    let release: (v: PasteResult) => void = () => undefined;
    paste.mockReturnValueOnce(new Promise<PasteResult>((resolve) => (release = resolve)));
    renderPane();
    type("一回だけ");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    expect(sendButton().disabled).toBe(true);
    await act(async () => release("sent"));
    expect(checkChatSend).toHaveBeenCalledTimes(1);
  });
});

describe("K6 送れるのは手すきのときだけ", () => {
  it.each([
    ["working", "Claude が作業中のため送れません"],
    ["stopped", "このセッションは停止しているため送れません"],
    ["unknown", "Claude の状態を確認できないため送れません"],
  ] as const)("%s のときは「送る」を押せず、理由の文を出す。Enter でも送らない", async (state, reason) => {
    renderPane({ state, canInput: false });
    type("送りたい");
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByTestId("chat-blocked").textContent).toContain(reason);
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 13 });
    await act(async () => undefined);
    expect(checkChatSend).not.toHaveBeenCalled();
    // 入力欄には書ける（作業が終わるまでの下書き）
    expect(input().value).toBe("送りたい");
  });

  it("確認の待ち（waiting）のときは「端末で確認が出ています」と、端末タブへ移るボタンを出す", () => {
    renderPane({ state: "waiting", canInput: false });
    expect(screen.getByTestId("chat-blocked").textContent).toContain("端末で確認が出ています");
    fireEvent.click(within(screen.getByTestId("chat-blocked")).getByRole("button", { name: "端末を開く" }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it("手すきのときは理由も端末を開くボタンも出ない", () => {
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
    expect(checkChatSend).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();
  });

  it("入力欄にすでに文章があるときは、改行を 1 つ挟んで後ろに足す", () => {
    renderPane();
    type("先に書いた文");
    fireEvent.click(within(screen.getByTestId("quick-prompt-bar")).getByRole("button", { name: "テスト実行" }));
    expect(input().value).toBe("先に書いた文\nテストを実行して");
  });

  it("送れない状態でも押せる（入力欄に入れるだけなので）", () => {
    renderPane({ state: "working", canInput: false });
    const button = within(screen.getByTestId("quick-prompt-bar")).getByRole("button", { name: "テスト実行" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(input().value).toBe("テストを実行して");
  });

  it("一覧（全件）の「使う」でも、本文が入力欄に入る", async () => {
    renderPane();
    fireEvent.click(within(screen.getByTestId("quick-prompt-bar")).getByRole("button", { name: "よく使う指示" }));
    const row = screen.getAllByTestId("quick-prompt-list-item")[1];
    fireEvent.click(within(row).getByRole("button", { name: "使う" }));
    expect(input().value).toBe("lint を実行して");
  });
});
