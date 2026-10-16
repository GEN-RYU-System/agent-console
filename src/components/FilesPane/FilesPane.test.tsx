// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n";
import type { FileContentResponse, FilesResponse, SessionFile } from "../../types";

const fetchFiles = vi.fn<(id: string) => Promise<FilesResponse>>();
const fetchFileContent = vi.fn<(id: string, path: string) => Promise<FileContentResponse>>();
vi.mock("../../api", () => ({
  fetchFiles: (id: string) => fetchFiles(id),
  fetchFileContent: (id: string, p: string) => fetchFileContent(id, p),
}));

const { FilesPane } = await import("./FilesPane");

const file = (p: string, over: Partial<SessionFile> = {}): SessionFile => ({ path: p, name: p.split("/").at(-1) ?? p, dir: p.slice(0, p.lastIndexOf("/")) || "/", tool: "Write", lastAt: Date.UTC(2026, 9, 14, 3, 0), byAgent: false, ...over });

beforeEach(() => {
  fetchFiles.mockReset();
  fetchFileContent.mockReset();
});
afterEach(cleanup);

describe("FilesPane", () => {
  it("閉じている間は取得しない。開くと一覧（名前・置き場所・担当の印）", async () => {
    fetchFiles.mockResolvedValue({ status: "ok", files: [file("/tmp/r/報告.md", { byAgent: true }), file("/tmp/r/a.txt")] });
    const { rerender } = render(<FilesPane sessionId="s1" active={false} rev={0} />);
    expect(fetchFiles).not.toHaveBeenCalled();
    rerender(<FilesPane sessionId="s1" active rev={0} />);
    expect(await screen.findByText("報告.md")).toBeTruthy();
    expect(screen.getAllByText("/tmp/r")).toHaveLength(2);
    expect(screen.getAllByText("担当")).toHaveLength(1);
  });

  it("K1 開いたまま rev が進むと一覧を取り直す", async () => {
    fetchFiles.mockResolvedValueOnce({ status: "ok", files: [] });
    const { rerender } = render(<FilesPane sessionId="s1" active rev={1} />);
    expect(await screen.findByText("このセッションが書いたファイルはまだありません")).toBeTruthy();
    expect(screen.getByText(/コマンドの出力（> など）/)).toBeTruthy();
    fetchFiles.mockResolvedValueOnce({ status: "ok", files: [file("/w/new.md")] });
    rerender(<FilesPane sessionId="s1" active rev={2} />);
    expect(await screen.findByText("new.md")).toBeTruthy();
    expect(fetchFiles).toHaveBeenCalledTimes(2);
  });

  it("K4 .md は整えた表示（見出し・表）。リンクは http・https だけ", async () => {
    fetchFiles.mockResolvedValue({ status: "ok", files: [file("/w/r.md")] });
    fetchFileContent.mockResolvedValue({ status: "ok", text: "# 見出し\n\n| a |\n| --- |\n| 1 |\n\n[外](https://example.com) [相対](/x)", size: 10, mtimeMs: 1, kind: "markdown" });
    const { container } = render(<FilesPane sessionId="s1" active rev={0} />);
    fireEvent.click(await screen.findByText("r.md"));
    await waitFor(() => expect(container.querySelector(".ac-md h1")?.textContent).toBe("見出し"));
    expect(fetchFileContent).toHaveBeenCalledWith("s1", "/w/r.md");
    expect(container.querySelector(".ac-md td")?.textContent).toBe("1");
    expect([...container.querySelectorAll(".ac-md a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
  });

  it("それ以外は等幅の pre（HTML として描画しない）", async () => {
    fetchFiles.mockResolvedValue({ status: "ok", files: [file("/w/a.html")] });
    fetchFileContent.mockResolvedValue({ status: "ok", text: "<b>太</b>", size: 8, mtimeMs: 1, kind: "text" });
    const { container } = render(<FilesPane sessionId="s1" active rev={0} />);
    fireEvent.click(await screen.findByText("a.html"));
    await waitFor(() => expect(container.querySelector("pre.ac-files__text")?.textContent).toBe("<b>太</b>"));
    expect(container.querySelector("b")).toBeNull();
  });

  it.each([
    [{ status: "tooLarge", size: 2000000 }, "1 MiB を超えるため表示しません（2000000 バイト）"],
    [{ status: "binary", size: 3 }, "文字のファイルではないため表示しません（3 バイト）"],
    [{ status: "missing" }, "ファイルが見つかりません（消されたか、移されました）"],
    [{ status: "notListed" }, "このセッションが書いたファイルの一覧にないため表示しません"],
    [{ status: "notRegular" }, "普通のファイルではないため表示しません（リンク・フォルダなど）"],
    [{ status: "unreadable" }, "このファイルは読めません"],
  ] as Array<[FileContentResponse, string]>)("K5 %o は中身を出さず理由を出す", async (res, message) => {
    fetchFiles.mockResolvedValue({ status: "ok", files: [file("/w/x.bin")] });
    fetchFileContent.mockResolvedValue(res);
    const { container } = render(<FilesPane sessionId="s1" active rev={0} />);
    fireEvent.click(await screen.findByText("x.bin"));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("claudeSessionId が無ければ noSession の案内", async () => {
    fetchFiles.mockResolvedValue({ status: "noSession" });
    render(<FilesPane sessionId="s1" active rev={0} />);
    expect(await screen.findByText("このセッションの会話の記録がまだありません")).toBeTruthy();
  });

  it("再読込ボタンで一覧を取り直す", async () => {
    fetchFiles.mockResolvedValue({ status: "ok", files: [] });
    render(<FilesPane sessionId="s1" active rev={0} />);
    await screen.findByText("このセッションが書いたファイルはまだありません");
    fireEvent.click(screen.getByRole("button", { name: "再読込" }));
    await waitFor(() => expect(fetchFiles).toHaveBeenCalledTimes(2));
  });
  it("K5 openRequest の seq が進むとそのパスを開く。同じ seq の再描画では開き直さず、別セッション宛は無視する", async () => {
    fetchFiles.mockResolvedValue({ status: "ok", files: [file("/w/a.md"), file("/w/b.txt")] });
    fetchFileContent.mockResolvedValue({ status: "ok", text: "中身", size: 2, mtimeMs: 1, kind: "text" });
    const { rerender, container } = render(<FilesPane sessionId="s1" active rev={0} openRequest={null} />);
    await screen.findByText("a.md");
    expect(fetchFileContent).not.toHaveBeenCalled();
    rerender(<FilesPane sessionId="s1" active rev={0} openRequest={{ sessionId: "s1", path: "/w/b.txt", seq: 1 }} />);
    await waitFor(() => expect(fetchFileContent).toHaveBeenCalledWith("s1", "/w/b.txt"));
    await waitFor(() => expect(container.querySelector("pre.ac-files__text")?.textContent).toBe("中身"));
    expect(container.querySelector('[aria-current="true"]')?.getAttribute("title")).toBe("/w/b.txt");
    rerender(<FilesPane sessionId="s1" active rev={1} openRequest={{ sessionId: "s1", path: "/w/b.txt", seq: 1 }} />);
    rerender(<FilesPane sessionId="s1" active rev={1} openRequest={{ sessionId: "other", path: "/w/a.md", seq: 2 }} />);
    expect(fetchFileContent).toHaveBeenCalledTimes(1);
  });
  describe("検索欄・端末に戻る", () => {
    const three = (): FilesResponse => ({ status: "ok", files: [file("/w/Report/報告.md"), file("/w/Report/a.txt"), file("/w/other/ABC.md")] });
    const box = (): HTMLInputElement => screen.getByLabelText("ファイル名で絞り込み") as HTMLInputElement;
    const names = (container: HTMLElement): string[] => [...container.querySelectorAll(".ac-files__name")].map((n) => n.textContent ?? "");

    it("K1 語の一部で絞られ件数が出る。複数語は全て含む物だけ。全角/半角・大小文字を区別しない。0件は該当なし。空欄で全件", async () => {
      fetchFiles.mockResolvedValue(three());
      const { container } = render(<FilesPane sessionId="s1" active rev={0} />);
      await screen.findByText("a.txt");
      expect(screen.queryByTestId("files-search-count")).toBeNull();
      fireEvent.change(box(), { target: { value: "report" } });
      expect(names(container)).toEqual(["報告.md", "a.txt"]);
      expect(screen.getByTestId("files-search-count").textContent).toBe("2 / 3 件");
      fireEvent.change(box(), { target: { value: "ｒｅｐｏｒｔ　ＭＤ" } });
      expect(names(container)).toEqual(["報告.md"]);
      fireEvent.change(box(), { target: { value: "abc" } });
      expect(names(container)).toEqual(["ABC.md"]);
      fireEvent.change(box(), { target: { value: "zzz" } });
      expect(screen.getByText("当てはまるファイルはありません")).toBeTruthy();
      expect(screen.getByTestId("files-search-count").textContent).toBe("0 / 3 件");
      fireEvent.change(box(), { target: { value: "" } });
      expect(names(container)).toEqual(["報告.md", "a.txt", "ABC.md"]);
      expect(screen.queryByTestId("files-search-count")).toBeNull();
      expect(fetchFiles).toHaveBeenCalledTimes(1);
    });

    it("K2 絞り込みで外れても開いているファイルの表示は消えない。セッションが替わると欄が空になる", async () => {
      fetchFiles.mockResolvedValue(three());
      fetchFileContent.mockResolvedValue({ status: "ok", text: "中身", size: 2, mtimeMs: 1, kind: "text" });
      const { container, rerender } = render(<FilesPane sessionId="s1" active rev={0} />);
      fireEvent.click(await screen.findByText("a.txt"));
      await waitFor(() => expect(container.querySelector("pre.ac-files__text")?.textContent).toBe("中身"));
      fireEvent.change(box(), { target: { value: "ABC" } });
      expect(names(container)).toEqual(["ABC.md"]);
      expect(container.querySelector(".ac-files__content-path")?.textContent).toBe("/w/Report/a.txt");
      rerender(<FilesPane sessionId="s2" active rev={0} />);
      await waitFor(() => expect(box().value).toBe(""));
    });

    it("K4 Esc: 検索欄に文字がある時の欄での1回目は欄を空にするだけ。空の欄・欄以外では戻る。IME 変換中は何もしない", async () => {
      fetchFiles.mockResolvedValue(three());
      const back = vi.fn();
      const { container } = render(<FilesPane sessionId="s1" active rev={0} onBackToTerminal={back} />);
      await screen.findByText("a.txt");
      fireEvent.change(box(), { target: { value: "rep" } });
      fireEvent.keyDown(box(), { key: "Escape", isComposing: true });
      expect(back).not.toHaveBeenCalled();
      expect(box().value).toBe("rep");
      fireEvent.keyDown(box(), { key: "Escape" });
      expect(box().value).toBe("");
      expect(back).not.toHaveBeenCalled();
      fireEvent.keyDown(box(), { key: "Escape" });
      expect(back).toHaveBeenCalledTimes(1);
      fireEvent.change(box(), { target: { value: "rep" } });
      fireEvent.keyDown(container.querySelector(".ac-files__file") as HTMLElement, { key: "Escape" });
      expect(back).toHaveBeenCalledTimes(2);
      expect(box().value).toBe("rep");
    });

    it("「端末に戻る」ボタンで onBackToTerminal を呼ぶ。表示になった時、焦点が外にあれば外枠へ移す", async () => {
      fetchFiles.mockResolvedValue(three());
      const back = vi.fn();
      const { container, rerender } = render(<FilesPane sessionId="s1" active={false} rev={0} onBackToTerminal={back} />);
      rerender(<FilesPane sessionId="s1" active rev={0} onBackToTerminal={back} />);
      await screen.findByText("a.txt");
      expect(document.activeElement).toBe(container.querySelector(".ac-files"));
      fireEvent.click(screen.getByRole("button", { name: "端末に戻る" }));
      expect(back).toHaveBeenCalledTimes(1);
    });
  });
});
