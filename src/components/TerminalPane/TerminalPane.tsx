import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Callout } from "@sa/components/Callout";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ApiError, openSocket, uploadFile, uploadImage } from "../../api";
import { splitByCodePoints } from "./chunkInput";
import { classifyTransfer, type TransferFile } from "./imageTransfer";
import { WheelClassifier, wheelDeltas } from "./wheelClassifier";
import { LineEmitter, WheelLineAccumulator } from "./wheelLines";
import { readTerminalAppearance } from "./terminalTokens";
import "./TerminalPane.css";

const SCROLLBACK_LINES = 2000;
/** サーバーの WebSocket 上限（256KB）より十分小さく分割して送る（大量貼り付け対策）。 */
const INPUT_CHUNK_CHARS = 16 * 1024;
/** 切れた端末のつなぎ直し: 1 秒・2 秒・4 秒…最大 10 秒 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
/** ホイールの信号を持つマウス追跡のモード（x10 は wheel を持たない） */
const WHEEL_TRACKING_MODES: ReadonlySet<string> = new Set(["vt200", "drag", "any"]);

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
  /** 文字の描き方（config の terminalRenderer）。"webgl" は GPU で描く。端末を作るときに 1 回だけ読む。既定は "dom" */
  renderer?: "webgl" | "dom";
  /** 画像 1 枚の上限（byte。config の値）。超えるものは送らずに案内する。サーバーも同じ上限で検査する */
  uploadMaxBytes?: number;
  onUploadNotice?: (notice: UploadNotice) => void;
}

/** 表示中の 1 本だけ xterm を生成する。sessionId が変わる/外れるたびに破棄して再接続する。 */
export const TerminalPane = forwardRef<TerminalHandle, TerminalPaneProps>(function TerminalPane({ sessionId, smoothScrollMs = 0, renderer = "dom", uploadMaxBytes, onUploadNotice }, ref) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  /** 端末の WebSocket が切れて、つなぎ直している間は true（案内を出す） */
  const [reconnecting, setReconnecting] = useState(false);
  /** 今の端末と、それがどのセッションのものか（effect で差し替わるので、同じ組で持つ） */
  const termRef = useRef<{ sessionId: string; term: Terminal } | null>(null);
  /** 画面から渡された値は、端末を作り直さずに読み直せるよう ref で持つ */
  const latest = useRef({ smoothScrollMs, renderer, uploadMaxBytes, onUploadNotice });
  latest.current = { smoothScrollMs, renderer, uploadMaxBytes, onUploadNotice };
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
    let webgl: WebglAddon | null = null;
    // 今どちらで描いているかを外から見えるようにする（試験・点検用）
    const markRenderer = (r: "webgl" | "dom"): void => {
      host.dataset.renderer = r;
    };
    markRenderer("dom");
    if (latest.current.renderer === "webgl") {
      try {
        webgl = new WebglAddon();
        // GPU の文脈を失って 3 秒で戻らなければ DOM 描画に戻す（addon の dispose で xterm が DOM レンダラへ切り替える）
        webgl.onContextLoss(() => {
          webgl?.dispose();
          webgl = null;
          markRenderer("dom");
        });
        term.loadAddon(webgl);
        markRenderer("webgl");
      } catch {
        // WebGL2 が無い環境では loadAddon の中で throw する。addon を外して DOM のまま続ける
        webgl?.dispose();
        webgl = null;
      }
    }
    termRef.current = { sessionId, term };

    // マウス追跡中（Claude など）のホイールは、行の数に直して 1 行 1 信号で少しずつ送る（設計: docs/handoff/terminal-wheel/design.md）。
    // 合成イベントは端末ごと（この effect の中）に持つ。connect() より前に作る
    const syntheticWheels = new WeakSet<WheelEvent>();
    const wheelAccumulator = new WheelLineAccumulator();
    let rafId = 0;
    const lineEmitter = new LineEmitter(
      (cb) => {
        rafId = requestAnimationFrame(cb);
      },
      () => cancelAnimationFrame(rafId),
    );
    const wheelTracked = (): boolean => WHEEL_TRACKING_MODES.has(term.modes.mouseTrackingMode);
    const screenOf = (): Element | null => term.element?.querySelector(".xterm-screen") ?? null;
    let wheelOrigin: { target: Element | null; x: number; y: number; ctrl: boolean; alt: boolean; meta: boolean } | null = null;
    const emitOneLine = (dir: 1 | -1): void => {
      // 送る直前の再確認: 端末が差し替わった・追跡が外れたなら、待ち行列を捨てて送らない
      if (termRef.current?.term !== term || !wheelTracked() || wheelOrigin === null) {
        lineEmitter.clear();
        return;
      }
      const target = wheelOrigin.target?.isConnected ? wheelOrigin.target : screenOf();
      if (target === null) return;
      const synthetic = new WheelEvent("wheel", {
        deltaMode: 1,
        deltaY: dir,
        clientX: wheelOrigin.x,
        clientY: wheelOrigin.y,
        ctrlKey: wheelOrigin.ctrl,
        altKey: wheelOrigin.alt,
        metaKey: wheelOrigin.meta,
        bubbles: true,
        cancelable: true,
      });
      syntheticWheels.add(synthetic);
      target.dispatchEvent(synthetic);
    };
    term.attachCustomWheelEventHandler((e: WheelEvent): boolean => {
      if (syntheticWheels.has(e)) return true;
      if (e.shiftKey || e.deltaY === 0 || !wheelTracked()) return true;
      const screen = screenOf();
      const cellHeight = screen === null ? 0 : screen.clientHeight / term.rows;
      if (!(cellHeight > 0)) return true;
      const lines = wheelAccumulator.add(e, cellHeight, term.rows);
      // 端数だけで 0 行のときも false（xterm 側に別の端数を溜めさせない）。積むのは 1 行以上のときだけ
      if (lines === 0) return false;
      wheelOrigin = {
        target: e.target instanceof Element ? e.target : screen,
        x: e.clientX,
        y: e.clientY,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      };
      lineEmitter.push(lines, emitOneLine, term.rows);
      return false;
    });

    // 切れたらつなぎ直す。send・syncSize は「今の ws」を見る（古い ws を閉包で持たない）
    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (msg: object): void => {
      if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const syncSize = (): void => {
      // 隠れている（display:none）間は大きさが 0。このまま合わせると 2 列×1 行が pty に送られて Claude の画面が崩れるので、何もしない
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      send({ type: "resize", cols: term.cols, rows: term.rows });
    };
    const release = (socket: WebSocket): void => {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
    };
    const connect = (): void => {
      if (ws !== null) release(ws);
      const socket = openSocket("/ws/term", { session: sessionId });
      ws = socket;
      socket.onopen = () => {
        if (disposed || ws !== socket) return;
        attempt = 0;
        setReconnecting(false);
        // つなぎ直しでは、サーバーが送る今の画面（ring・replay）を描き直す。前の中身は消す
        lineEmitter.clear();
        wheelAccumulator.reset();
        term.reset();
        syncSize();
      };
      socket.onmessage = (e) => {
        if (ws === socket) term.write(typeof e.data === "string" ? e.data : "");
      };
      socket.onclose = () => {
        if (disposed || ws !== socket) return;
        setReconnecting(true);
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };
    connect();
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
      if (syntheticWheels.has(e)) return;
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
      lineEmitter.dispose();
      disposed = true;
      clearTimeout(retryTimer);
      if (ws !== null) {
        release(ws);
        ws.close();
      }
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="ac-terminal-wrap">
      <div ref={hostRef} className="ac-terminal" data-testid="terminal" />
      {reconnecting && (
        <div className="ac-terminal__reconnecting" data-testid="terminal-reconnecting">
          <Callout variant="info" title={t("ac.terminalReconnecting")} />
        </div>
      )}
    </div>
  );
});
