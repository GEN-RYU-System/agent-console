import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ApiError, openSocket, uploadFile, uploadImage } from "../../api";
import { splitByCodePoints } from "./chunkInput";
import { classifyTransfer, type TransferFile } from "./imageTransfer";
import { WheelClassifier, wheelDeltas } from "./wheelClassifier";
import { readTerminalAppearance } from "./terminalTokens";
import "./TerminalPane.css";

const SCROLLBACK_LINES = 2000;
/** サーバーの WebSocket 上限（256KB）より十分小さく分割して送る（大量貼り付け対策）。 */
const INPUT_CHUNK_CHARS = 16 * 1024;

export interface TerminalHandle {
  /**
   * sessionId の端末に、文章を xterm の paste() で入れるだけ。Enter は送らない。入れたあと端末に入力の焦点を移す
   * （焦点がボタンに残ると、続けて押した Enter でボタンが押し直されるため）。
   * sessionId は「状態を確認したセッション」。今表示している端末がそれと違う（確認中に別のセッションへ切り替わった）ときは
   * 何も入れずに false を返す。入れたら true。
   * paste() は、端末側が括弧付き貼付モードを有効にしていればそれで包み、そうでなければ改行を \r に直して入れる
   * （@xterm/xterm の d.ts: 「Writes text to the terminal, performing the necessary transformations for pasted text」）。
   * どちらも onData を通って WebSocket の人の入力経路に出る。
   */
  pasteOnly(sessionId: string, text: string): boolean;
  /**
   * 文章を貼ってから delayMs 待ち、その後に Enter を送る（複数行を 1 つの依頼として受け取らせるため。本物の claude で 2 秒待つと
   * `[Pasted text #N]` の 1 つの依頼になることを実測した）。
   * 貼る前に表示中の端末が sessionId と違えば何もせず "notPasted"。待っている間に端末が差し替わった（別のセッションへ切り替えた・
   * 戻した）ときは Enter を送らず "pastedNotSent"。送れたら "sent"。
   */
  pasteSubmitAfter(sessionId: string, text: string, delayMs: number): Promise<PasteResult>;
}

export type PasteResult = "sent" | "notPasted" | "pastedNotSent";

/** 画像の添付で画面に案内を出す場面（文言は呼び出し側の i18n） */
export type UploadNotice = "tooLarge" | "failed" | "switched";

export interface TerminalPaneProps {
  sessionId: string;
  /** 物理的なマウスのホイールのときの、なめらかなスクロールの時間（ms。config の値。0 で無し）。トラックパッドなどでは常に 0 */
  smoothScrollMs?: number;
  /** 画像 1 枚の上限（byte。config の値）。超えるものは送らずに案内する。サーバーも同じ上限で検査する */
  uploadMaxBytes?: number;
  onUploadNotice?: (notice: UploadNotice) => void;
}

/** 表示中の 1 本だけ xterm を生成する。sessionId が変わる/外れるたびに破棄して再接続する。 */
export const TerminalPane = forwardRef<TerminalHandle, TerminalPaneProps>(function TerminalPane({ sessionId, smoothScrollMs = 0, uploadMaxBytes, onUploadNotice }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** 今の端末と、それがどのセッションのものか（effect で差し替わるので、同じ組で持つ） */
  const termRef = useRef<{ sessionId: string; term: Terminal } | null>(null);
  /** 画面から渡された値は、端末を作り直さずに読み直せるよう ref で持つ */
  const latest = useRef({ smoothScrollMs, uploadMaxBytes, onUploadNotice });
  latest.current = { smoothScrollMs, uploadMaxBytes, onUploadNotice };
  /** 今の入力機器が物理ホイールか（変わったときだけ smoothScrollDuration を更新する） */
  const physicalWheelRef = useRef(false);

  // 設定の値が変わったら、使っている端末に反映する
  useEffect(() => {
    const current = termRef.current;
    if (current) current.term.options.smoothScrollDuration = physicalWheelRef.current ? smoothScrollMs : 0;
  }, [smoothScrollMs]);

  useImperativeHandle(
    ref,
    () => ({
      pasteOnly(expectedSessionId: string, text: string): boolean {
        const current = termRef.current;
        if (!current || current.sessionId !== expectedSessionId) return false;
        current.term.paste(text);
        current.term.focus();
        return true;
      },
      async pasteSubmitAfter(expectedSessionId: string, text: string, delayMs: number): Promise<PasteResult> {
        const current = termRef.current;
        if (!current || current.sessionId !== expectedSessionId) return "notPasted";
        current.term.paste(text);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        // 待つ間に端末が差し替わっていたら（同じセッションに戻っていても別の端末）、Enter は送らない
        if (termRef.current?.term !== current.term) return "pastedNotSent";
        current.term.input("\r", true);
        return "sent";
      },
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      // 入力機器が分かるまでは 0（ブラウザのそのままの動き）。物理ホイールと分かってから latest の値にする
      smoothScrollDuration: 0,
      ...readTerminalAppearance(),
    });
    physicalWheelRef.current = false;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = { sessionId, term };

    const ws = openSocket("/ws/term", { session: sessionId });
    const send = (msg: object): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const syncSize = (): void => {
      // 隠れている（display:none）間は大きさが 0。このまま合わせると 2 列×1 行が pty に送られて Claude の画面が崩れるので、何もしない
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      send({ type: "resize", cols: term.cols, rows: term.rows });
    };

    ws.onopen = syncSize;
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
    const dataSub = term.onData((data) => {
      for (const chunk of splitByCodePoints(data, INPUT_CHUNK_CHARS)) send({ type: "input", data: chunk });
    });
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(host);

    // ダーク切替（<html> の class 変化）に追従して配色・文字サイズを読み直す
    const themeObserver = new MutationObserver(() => {
      const appearance = readTerminalAppearance();
      term.options.theme = appearance.theme;
      term.options.fontFamily = appearance.fontFamily;
      term.options.fontSize = appearance.fontSize;
      syncSize();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    fit.fit();

    // なめらかなスクロール: 物理的なマウスのホイールのときだけ（VS Code と同じ。トラックパッドでは切る）
    const wheelClassifier = new WheelClassifier();
    const onWheel = (e: WheelEvent): void => {
      const { dx, dy } = wheelDeltas(e);
      wheelClassifier.accept(Date.now(), dx, dy);
      const physical = wheelClassifier.isPhysicalMouseWheel();
      if (physical === physicalWheelRef.current) return;
      physicalWheelRef.current = physical;
      term.options.smoothScrollDuration = physical ? latest.current.smoothScrollMs : 0;
    };
    host.addEventListener("wheel", onWheel, { capture: true, passive: true });

    // 画像の添付: 保存してもらい、その絶対パスを入力欄に貼る（Enter は押さない）。1 つずつ順に行う
    const notify = (notice: UploadNotice): void => latest.current.onUploadNotice?.(notice);
    const attachOne = async ({ file, kind }: TransferFile): Promise<void> => {
      const max = latest.current.uploadMaxBytes;
      if (max !== undefined && file.size > max) return notify("tooLarge");
      try {
        const { path } = await (kind === "image" ? uploadImage(file) : uploadFile(file));
        // 待つ間にセッションが切り替わった（別の端末になった）ら入れない
        if (termRef.current?.term !== term) return notify("switched");
        term.paste(` ${path} `);
      } catch (err) {
        notify(err instanceof ApiError && err.status === 413 ? "tooLarge" : "failed");
      }
    };
    let uploadChain: Promise<void> = Promise.resolve();
    const attach = (files: TransferFile[]): void => {
      for (const item of files) uploadChain = uploadChain.then(() => attachOne(item));
    };
    const onPaste = (e: ClipboardEvent): void => {
      const { files, text } = classifyTransfer(e.clipboardData);
      // 文字があるときは今までどおり xterm に任せる（文字とファイルの二重の貼り付けを防ぐ）
      if (files.length === 0 || text !== "") return;
      e.preventDefault();
      e.stopPropagation();
      attach(files);
    };
    // 止めないと、ブラウザがファイルをページとして開き、アプリの画面が置き換わる
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      attach(classifyTransfer(e.dataTransfer).files);
    };
    host.addEventListener("paste", onPaste, true);
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);

    return () => {
      host.removeEventListener("wheel", onWheel, true);
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      dataSub.dispose();
      ws.close();
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={hostRef} className="ac-terminal" data-testid="terminal" />;
});
