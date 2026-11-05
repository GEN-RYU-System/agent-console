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
  /** 今すぐ書ける状態か（用意済み・取り直し中でない・接続あり）と、ため込んだ書き込みの件数。読み取りだけで何も書かない（case-say 用） */
  writeState?(): { writable: boolean; pending: number };
  /** 区画の番号 `%N` を宛先に、ため込まずに今の接続へ条件付きで送る。pid は tmux が実行する時点で区画の pid と一致したときだけ書く（case-say 用） */
  sendToPane?(pane: string, pid: number, data: string): Promise<PaneSendResult>;
  /** 区画 `%N` の今の pid を、今の接続から聞く。聞けなければ null（case-say 用） */
  queryPanePid?(pane: string): Promise<number | null>;
}

/** sendToPane の結果。written は、すべての条件付きの送りが「書いた」と読めたときだけ true */
export type PaneSendResult = { written: true } | { written: false; reason: "not_writable" | "not_written" | "no_response" | "invalid" };

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
