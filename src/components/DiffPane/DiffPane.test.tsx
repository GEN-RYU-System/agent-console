// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { DiffComment, SessionState } from "../../types";

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const fetchDiff = vi.fn();
const fetchDiffFile = vi.fn();
const fetchDiffComments = vi.fn();
const createDiffComment = vi.fn();
const updateDiffComment = vi.fn();
const deleteDiffComment = vi.fn();
const checkDiffCommentsSend = vi.fn();
const markDiffCommentsSent = vi.fn();
vi.mock("../../api", () => ({
  ApiError: FakeApiError,
  fetchDiff: (id: string) => fetchDiff(id),
  fetchDiffFile: (id: string, p: string) => fetchDiffFile(id, p),
  fetchDiffComments: (id: string) => fetchDiffComments(id),
  createDiffComment: (id: string, i: unknown) => createDiffComment(id, i),
  updateDiffComment: (id: string, cid: string, i: unknown) => updateDiffComment(id, cid, i),
  deleteDiffComment: (id: string, cid: string) => deleteDiffComment(id, cid),
  checkDiffCommentsSend: (id: string) => checkDiffCommentsSend(id),
  markDiffCommentsSent: (id: string, ids: string[]) => markDiffCommentsSent(id, ids),
}));

const { DiffPane } = await import("./DiffPane");

const LIST = {
  baseRef: "origin/main",
  files: [
    { path: "src/a.ts", added: 2, removed: 1, binary: false, untracked: false },
    { path: "new.txt", added: 0, removed: 0, binary: false, untracked: true },
    { path: "img.png", added: 0, removed: 0, binary: true, untracked: false },
    { path: "huge.txt", added: 9, removed: 9, binary: false, untracked: false },
  ],
};
const LINES = [
  { kind: "hunk", text: "@@ -1,3 +1,4 @@" },
  { kind: "ctx", oldLine: 1, newLine: 1, text: "keep" },
  { kind: "del", oldLine: 2, text: "old line" },
  { kind: "add", newLine: 2, text: "new line" },
  { kind: "add", newLine: 3, text: "another" },
];
const comment = (over: Partial<DiffComment> = {}): DiffComment => ({ id: "c1", path: "src/a.ts", side: "new", line: 2, lineText: "new line", body: "直して", createdAt: 1, ...over });

type PasteFn = (sessionId: string, text: string, delayMs: number) => Promise<"sent" | "notPasted" | "pastedNotSent">;
const paste = vi.fn<PasteFn>();
const onCountChange = vi.fn();

function renderPane(over: Partial<{ state: SessionState; canInput: boolean; sessionId: string }> = {}) {
  return render(<DiffPane sessionId="s1" active state="idle" canInput paste={paste} onCountChange={onCountChange} {...over} />);
}

beforeEach(() => {
  for (const f of [fetchDiff, fetchDiffFile, fetchDiffComments, createDiffComment, updateDiffComment, deleteDiffComment, checkDiffCommentsSend, markDiffCommentsSent, paste, onCountChange]) f.mockReset();
  fetchDiff.mockResolvedValue(LIST);
  fetchDiffFile.mockImplementation(async (_id: string, p: string) => {
    if (p === "huge.txt") return { tooLarge: true };
    if (p === "img.png") return { binary: true };
    if (p === "new.txt") return { untracked: true };
    return { lines: LINES };
  });
  fetchDiffComments.mockResolvedValue({ items: [] });
  createDiffComment.mockImplementation(async (_id: string, i: Record<string, unknown>) => ({ id: "c1", createdAt: 1, ...i }));
  updateDiffComment.mockImplementation(async (_id: string, cid: string, i: Record<string, unknown>) => ({ id: cid, createdAt: 1, ...i }));
  deleteDiffComment.mockResolvedValue({ removed: true });
  checkDiffCommentsSend.mockResolvedValue({ text: "TEXT", ids: ["c1"], submitDelayMs: 2000 });
  markDiffCommentsSent.mockResolvedValue({ marked: true });
});

const openFile = async (name: string): Promise<void> => {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name.replace(".", "\\.")) }));
};

describe("DiffPane: list and file (K1, K2, K7, K8)", () => {
  it("lists the changed files with the counts and marks untracked ones, and reports the count", async () => {
    renderPane();
    expect(await screen.findByRole("button", { name: /src\/a\.ts/ })).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByText("新しいファイル（未追加）")).toBeTruthy();
    expect(screen.getByText(/origin\/main/)).toBeTruthy();
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(4));
  });

  it("shows the lines of the chosen file with line numbers, and kinds that the stylesheet colors", async () => {
    renderPane();
    await openFile("src/a.ts");
    await waitFor(() => expect(fetchDiffFile).toHaveBeenCalledWith("s1", "src/a.ts"));
    const added = await screen.findAllByTestId("diff-line-add");
    expect(added.map((e) => e.textContent)).toEqual([expect.stringContaining("new line"), expect.stringContaining("another")]);
    expect(screen.getAllByTestId("diff-line-del")[0].textContent).toContain("old line");
    expect(screen.getAllByTestId("diff-line-ctx")).toHaveLength(1);
  });

  it("colors added lines with the Sales Anchor success background token and deleted lines with the error background token", () => {
    const css = readFileSync("src/components/DiffPane/DiffPane.css", "utf8");
    expect(css).toMatch(/\.ac-diff__line--add[^{]*\{[^}]*background:\s*var\(--color-success-bg\)/);
    expect(css).toMatch(/\.ac-diff__line--del[^{]*\{[^}]*background:\s*var\(--color-error-bg\)/);
  });

  it("says the changes cannot be shown when the working directory is outside (409)", async () => {
    fetchDiff.mockRejectedValue(new FakeApiError("working directory is outside", 409));
    renderPane();
    expect(await screen.findByText("この作業場所の変更は表示できません")).toBeTruthy();
  });

  it("says the base is missing when the server answers noBase", async () => {
    fetchDiff.mockResolvedValue({ error: "noBase", baseRef: "origin/main" });
    renderPane();
    expect(await screen.findByText("基準（origin/main）が見つかりません")).toBeTruthy();
  });

  it("shows a message instead of the body for too-large, binary and untracked files", async () => {
    renderPane();
    await openFile("huge.txt");
    expect(await screen.findByText("大きすぎるため表示しません")).toBeTruthy();
    await openFile("img.png");
    expect(await screen.findByText("バイナリのため表示しません")).toBeTruthy();
    await openFile("new.txt");
    expect(await screen.findByText(/まだ追加されていないファイル/)).toBeTruthy();
  });
});

describe("DiffPane: comments (K3)", () => {
  it("opens a comment box under a clicked line, saves it with the side, line and line text, and marks the line", async () => {
    renderPane();
    await openFile("src/a.ts");
    fireEvent.click((await screen.findAllByTestId("diff-line-add"))[0]);
    fireEvent.change(screen.getByLabelText("コメント"), { target: { value: "ここを直す" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(createDiffComment).toHaveBeenCalledWith("s1", { path: "src/a.ts", side: "new", line: 2, lineText: "new line", body: "ここを直す" }));
    expect((await screen.findAllByTestId("diff-comment"))[0].textContent).toContain("ここを直す");
  });

  it("uses the old side for a deleted line and the new side for a context line", async () => {
    renderPane();
    await openFile("src/a.ts");
    fireEvent.click((await screen.findAllByTestId("diff-line-del"))[0]);
    fireEvent.change(screen.getByLabelText("コメント"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(createDiffComment).toHaveBeenLastCalledWith("s1", expect.objectContaining({ side: "old", line: 2, lineText: "old line" })));
  });

  it("comments on the whole file with side=file and no line", async () => {
    renderPane();
    await openFile("src/a.ts");
    fireEvent.click(await screen.findByRole("button", { name: "ファイル全体にコメント" }));
    fireEvent.change(screen.getByLabelText("コメント"), { target: { value: "全体" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(createDiffComment).toHaveBeenCalledWith("s1", { path: "src/a.ts", side: "file", body: "全体" }));
  });

  it("edits and deletes an existing comment", async () => {
    fetchDiffComments.mockResolvedValue({ items: [comment()] });
    renderPane();
    await openFile("src/a.ts");
    const box = await screen.findByTestId("diff-comment");
    fireEvent.click(within(box).getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("コメント"), { target: { value: "直しました" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateDiffComment).toHaveBeenCalledWith("s1", "c1", { path: "src/a.ts", side: "new", line: 2, lineText: "new line", body: "直しました" }));
    fireEvent.click(within(await screen.findByTestId("diff-comment")).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(deleteDiffComment).toHaveBeenCalledWith("s1", "c1"));
    await waitFor(() => expect(screen.queryByTestId("diff-comment")).toBeNull());
  });

  it("shows 'ずれた可能性' when the line text now differs from the saved one, and not when it matches", async () => {
    fetchDiffComments.mockResolvedValue({ items: [comment({ id: "same" }), comment({ id: "moved", line: 3, lineText: "something else" })] });
    renderPane();
    await openFile("src/a.ts");
    const boxes = await screen.findAllByTestId("diff-comment");
    expect(boxes).toHaveLength(2);
    expect(within(boxes[0]).queryByText("ずれた可能性")).toBeNull();
    expect(within(boxes[1]).getByText("ずれた可能性")).toBeTruthy();
  });

  it("keeps a half-written comment when the tab is closed and opened again (the file is re-read without clearing the view)", async () => {
    const view = renderPane();
    await openFile("src/a.ts");
    fireEvent.click((await screen.findAllByTestId("diff-line-add"))[0]);
    fireEvent.change(screen.getByLabelText("コメント"), { target: { value: "書きかけ" } });
    view.rerender(<DiffPane sessionId="s1" active={false} state="idle" canInput paste={paste} onCountChange={onCountChange} />);
    view.rerender(<DiffPane sessionId="s1" active state="idle" canInput paste={paste} onCountChange={onCountChange} />);
    await waitFor(() => expect(fetchDiffFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchDiff).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText("コメント") as HTMLTextAreaElement).value).toBe("書きかけ");
  });

  it("tells that the comments could not be read when the data file is broken", async () => {
    fetchDiffComments.mockRejectedValue(new FakeApiError("comments unreadable", 500));
    renderPane();
    expect(await screen.findByText("コメントを読めませんでした")).toBeTruthy();
  });

  it("uses the generic message, not 'unreadable', for other failures of the comments request", async () => {
    fetchDiffComments.mockRejectedValue(new FakeApiError("boom", 500));
    renderPane();
    expect(await screen.findByText("コメントを取得できませんでした")).toBeTruthy();
    expect(screen.queryByText("コメントを読めませんでした")).toBeNull();
  });

  it("shows the server's message when saving fails and keeps the typed text", async () => {
    createDiffComment.mockRejectedValue(new Error("body must be at most 2000 characters"));
    renderPane();
    await openFile("src/a.ts");
    fireEvent.click((await screen.findAllByTestId("diff-line-add"))[0]);
    fireEvent.change(screen.getByLabelText("コメント"), { target: { value: "長い" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("2000");
    expect((screen.getByLabelText("コメント") as HTMLTextAreaElement).value).toBe("長い");
  });
});

describe("DiffPane: sending to Claude (K5, K6, K14)", () => {
  beforeEach(() => {
    fetchDiffComments.mockResolvedValue({ items: [comment(), comment({ id: "c2", sentAt: 5 })] });
  });
  const sendButton = (): HTMLButtonElement => screen.getByRole("button", { name: /Claude に送る/ }) as HTMLButtonElement;

  it("shows the unsent count on the button and sends the checked text through the paste callback, then marks the ids sent", async () => {
    paste.mockResolvedValue("sent");
    renderPane();
    await waitFor(() => expect(sendButton().textContent).toContain("1件"));
    fireEvent.click(sendButton());
    await waitFor(() => expect(markDiffCommentsSent).toHaveBeenCalledWith("s1", ["c1"]));
    expect(paste).toHaveBeenCalledWith("s1", "TEXT", 2000);
    expect(paste.mock.invocationCallOrder[0]).toBeLessThan(markDiffCommentsSent.mock.invocationCallOrder[0]);
  });

  it("disables the button and writes the reason next to it, always visible, while Claude is working", async () => {
    renderPane({ state: "working", canInput: false });
    await waitFor(() => expect(sendButton().textContent).toContain("1件"));
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("Claude が作業中のため送れません")).toBeTruthy();
    fireEvent.click(sendButton());
    expect(checkDiffCommentsSend).not.toHaveBeenCalled();
  });

  it("writes a reason for a waiting (permission prompt) state", async () => {
    renderPane({ state: "waiting", canInput: false });
    expect(await screen.findByText("Claude が許可の確認などを待っているため送れません")).toBeTruthy();
  });

  it("disables the button when there is nothing unsent and says so", async () => {
    fetchDiffComments.mockResolvedValue({ items: [comment({ sentAt: 5 })] });
    renderPane();
    expect(await screen.findByText("送るコメントがありません")).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  it("marks sent comments with 送信済み", async () => {
    renderPane();
    await openFile("src/a.ts");
    await waitFor(() => expect(screen.getAllByText("送信済み").length).toBeGreaterThan(0));
  });

  it("keeps the button disabled while the paste and the wait are in progress (no double paste)", async () => {
    let finish: (v: "sent") => void = () => undefined;
    paste.mockImplementation(() => new Promise((resolve) => (finish = resolve as typeof finish)));
    renderPane();
    await waitFor(() => expect(sendButton().textContent).toContain("1件"));
    fireEvent.click(sendButton());
    await waitFor(() => expect(paste).toHaveBeenCalled());
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("送信中")).toBeTruthy();
    finish("sent");
    await waitFor(() => expect(markDiffCommentsSent).toHaveBeenCalled());
  });

  it("when the terminal reports it pasted but did not press Enter (session switched during the wait): no mark-sent, and tells the user to press Enter", async () => {
    paste.mockResolvedValue("pastedNotSent");
    renderPane();
    await waitFor(() => expect(sendButton().textContent).toContain("1件"));
    fireEvent.click(sendButton());
    expect(await screen.findByText("貼り付けましたが送っていません。そのセッションの端末で Enter を押してください")).toBeTruthy();
    expect(markDiffCommentsSent).not.toHaveBeenCalled();
  });

  it("when nothing was pasted (switched before the paste): no mark-sent and the switched message", async () => {
    paste.mockResolvedValue("notPasted");
    renderPane();
    await waitFor(() => expect(sendButton().textContent).toContain("1件"));
    fireEvent.click(sendButton());
    expect((await screen.findByText(/別のセッションへ切り替わったため/)).textContent).toBeTruthy();
    expect(markDiffCommentsSent).not.toHaveBeenCalled();
  });

  it("shows the server's refusal (409 etc.) and does not paste", async () => {
    checkDiffCommentsSend.mockRejectedValue(new Error("claude is busy"));
    renderPane();
    await waitFor(() => expect(sendButton().textContent).toContain("1件"));
    fireEvent.click(sendButton());
    expect((await screen.findByRole("alert")).textContent).toContain("claude is busy");
    expect(paste).not.toHaveBeenCalled();
  });
});
