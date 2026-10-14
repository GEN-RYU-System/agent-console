/** 端末の層の型。direct（node-pty）と tmux（control mode）が同じ形で見える。 */
export interface TerminalHandle {
  /** 中の命令（pane）の pid。再接続の準備中は 0 のことがあり、つながった後に実値になる */
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** 中の命令を終わらせる（tmux では kill-session） */
  kill(): void;
  /** サーバー停止用。direct は kill。tmux は control client だけ閉じ、本体には触らない */
  release(): void;
  /** つなぎ直しの先入れ（画面の復元）。受け取った側は ring を置き換えて、つながっている画面に送る */
  onReplay?(listener: (data: string) => void): void;
  /** 端末につながった／つなげない */
  onStatus?(listener: (status: "connected" | "failed") => void): void;
}

export type TerminalHostKind = "tmux" | "direct";

/** tmux を呼ぶのに必要な情報 */
export interface TmuxContext {
  tmux: string;
  socket: string;
  conf: string;
}

export interface TerminalLogger {
  info(message: string): void;
  warn(message: string): void;
}

export const consoleLogger: TerminalLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
};
