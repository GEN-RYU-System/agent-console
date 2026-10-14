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
});
