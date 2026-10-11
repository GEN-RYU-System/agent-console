import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { wsUrl } from "../../api";
import { readTerminalAppearance } from "./terminalTokens";
import "./TerminalPane.css";

const SCROLLBACK_LINES = 2000;
/** サーバーの WebSocket 上限（256KB）より十分小さく分割して送る（大量貼り付け対策）。 */
const INPUT_CHUNK_CHARS = 16 * 1024;

/** 表示中の 1 本だけ xterm を生成する。sessionId が変わる/外れるたびに破棄して再接続する。 */
export function TerminalPane({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      fontFamily: "monospace",
      ...readTerminalAppearance(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const ws = new WebSocket(wsUrl("/ws/term", { session: sessionId }));
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
      for (let i = 0; i < data.length; i += INPUT_CHUNK_CHARS) {
        send({ type: "input", data: data.slice(i, i + INPUT_CHUNK_CHARS) });
      }
    });
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(host);

    // ダーク切替（<html> の class 変化）に追従して配色・文字サイズを読み直す
    const themeObserver = new MutationObserver(() => {
      const appearance = readTerminalAppearance();
      term.options.theme = appearance.theme;
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
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={hostRef} className="ac-terminal" data-testid="terminal" />;
}
