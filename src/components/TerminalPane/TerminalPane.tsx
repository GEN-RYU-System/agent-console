import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { wsUrl } from "../../api";
import "./TerminalPane.css";

const SCROLLBACK_LINES = 2000;

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 表示中の 1 本だけ xterm を生成する。sessionId が変わる/外れるたびに破棄して再接続する。 */
export function TerminalPane({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      fontSize: 13,
      fontFamily: "monospace",
      theme: {
        background: token("--bg-surface"),
        foreground: token("--text-primary"),
        cursor: token("--text-primary"),
      },
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
    const dataSub = term.onData((data) => send({ type: "input", data }));
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);
    fit.fit();

    return () => {
      observer.disconnect();
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={hostRef} className="ac-terminal" data-testid="terminal" />;
}
