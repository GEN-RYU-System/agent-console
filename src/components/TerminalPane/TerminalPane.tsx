import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { openSocket } from "../../api";
import { splitByCodePoints } from "./chunkInput";
import { readTerminalAppearance } from "./terminalTokens";
import "./TerminalPane.css";

const SCROLLBACK_LINES = 2000;
/** サーバーの WebSocket 上限（256KB）より十分小さく分割して送る（大量貼り付け対策）。 */
const INPUT_CHUNK_CHARS = 16 * 1024;

export interface TerminalHandle {
  /**
   * sessionId の端末に、文章を xterm の paste() で入れ、その後 Enter（\r）を送る。
   * sessionId は「状態を確認したセッション」。今表示している端末がそれと違う（確認中に別のセッションへ切り替わった）ときは
   * 何も入れずに false を返す。入れたら true。
   * paste() は、端末側が括弧付き貼付モードを有効にしていればそれで包み、そうでなければ改行を \r に直して入れる
   * （@xterm/xterm の d.ts: 「Writes text to the terminal, performing the necessary transformations for pasted text」）。
   * どちらも onData を通って WebSocket の人の入力経路に出る。
   */
  pasteAndEnter(sessionId: string, text: string): boolean;
}

/** 表示中の 1 本だけ xterm を生成する。sessionId が変わる/外れるたびに破棄して再接続する。 */
export const TerminalPane = forwardRef<TerminalHandle, { sessionId: string }>(function TerminalPane({ sessionId }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** 今の端末と、それがどのセッションのものか（effect で差し替わるので、同じ組で持つ） */
  const termRef = useRef<{ sessionId: string; term: Terminal } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      pasteAndEnter(expectedSessionId: string, text: string): boolean {
        const current = termRef.current;
        if (!current || current.sessionId !== expectedSessionId) return false;
        current.term.paste(text);
        current.term.input("\r", true);
        return true;
      },
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      ...readTerminalAppearance(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = { sessionId, term };

    const ws = openSocket("/ws/term", { session: sessionId });
    const send = (msg: object): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const syncSize = (): void => {
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

    return () => {
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
