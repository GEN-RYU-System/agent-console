import type { TmuxContext } from "./types.ts";

/** send-keys 1 本に載せるバイト数（上限 9,780 に十分な余裕。step0c C2） */
export const SEND_KEYS_CHUNK_BYTES = 1000;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** tmux セッション名。`:` と `.` は target の区切りなので拒否する */
export function sessionName(id: string): string {
  if (!SESSION_ID_PATTERN.test(id)) throw new Error(`invalid session id for tmux: ${JSON.stringify(id)}`);
  return `ac-${id}`;
}

/** セッション命令（has-session・kill-session・attach-session）の target。`=` で完全一致 */
export const sessionTarget = (name: string): string => `=${name}`;
/** pane 命令（display・send-keys・capture-pane）の target */
export const paneTarget = (name: string): string => `=${name}:`;

/** tmux を呼ぶ全ての命令に付ける共通の引数（専用ソケットと設定ファイルを毎回指定する） */
export function commonArgs(ctx: TmuxContext): string[] {
  return ["-u", "-L", ctx.socket, "-f", ctx.conf];
}

/** `\ooo`（8進3桁）を戻す。入力は latin1 で読んだ文字列（1文字=1バイト）。80 以上のバイトはそのまま */
export function unescapeOutput(value: string): Buffer {
  const out = Buffer.alloc(value.length);
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x5c && i + 3 < value.length && /^[0-7]{3}$/.test(value.slice(i + 1, i + 4))) {
      out[n++] = parseInt(value.slice(i + 1, i + 4), 8) & 0xff;
      i += 3;
    } else {
      out[n++] = c & 0xff;
    }
  }
  return out.subarray(0, n);
}

/** 文字列を UTF-8 のバイトにして、1000 バイトごとの `send-keys -H` 命令（1 行ずつ）にする */
export function sendKeysCommands(name: string, data: string, chunk = SEND_KEYS_CHUNK_BYTES): string[] {
  const bytes = Buffer.from(data, "utf8");
  const commands: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    const hex = [...bytes.subarray(i, i + chunk)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    commands.push(`send-keys -t ${paneTarget(name)} -H ${hex}`);
  }
  return commands;
}

export const resizeCommand = (cols: number, rows: number): string => `refresh-client -C ${cols}x${rows}`;

export type HasSessionResult = "alive" | "gone" | "unreachable";

/** has-session（や display）の結果を振り分ける（設計 3-2 の表） */
export function classifyHasSession(status: number | null, stderr: string): HasSessionResult {
  if (status === 0) return "alive";
  if (/can't find session|no server running|no current target/.test(stderr)) return "gone";
  // tmux サーバー自体が無い（再起動直後など）: ソケットが無い／接続拒否。Permission denied などは unreachable のまま
  if (/error connecting to .*\((No such file or directory|Connection refused)\)/.test(stderr)) return "gone";
  return "unreachable";
}

export interface ControlBlock {
  num: number;
  flags: number;
  ok: boolean;
  /** 内容の行（latin1 の文字列。UTF-8 に戻すには decodeLine） */
  lines: string[];
}

export type ControlEvent =
  | { kind: "block"; block: ControlBlock }
  | { kind: "output"; pane: string; data: Buffer }
  | { kind: "notice"; line: string };

export const decodeLine = (line: string): string => Buffer.from(line, "latin1").toString("utf8");

/**
 * control mode の出力を行にして意味づける。
 * `%begin t n flags` 〜 `%end|%error t n flags` の間は内容行（番号が合う終わりだけを終わりとみなす）。
 * ブロックの外では `%output %pane value` と、その他の通知（%exit など）。
 */
export class ControlParser {
  private pending: Buffer = Buffer.alloc(0);
  private current: { num: number; flags: number; lines: string[] } | null = null;

  push(chunk: Buffer): ControlEvent[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const events: ControlEvent[] = [];
    let start = 0;
    for (;;) {
      const nl = this.pending.indexOf(0x0a, start);
      if (nl < 0) break;
      let line = this.pending.toString("latin1", start, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      start = nl + 1;
      const ev = this.line(line);
      if (ev) events.push(ev);
    }
    this.pending = this.pending.subarray(start);
    return events;
  }

  private line(line: string): ControlEvent | null {
    const cur = this.current;
    if (cur) {
      const m = /^%(end|error) \d+ (\d+) (\d+)$/.exec(line);
      if (m && Number(m[2]) === cur.num) {
        this.current = null;
        return { kind: "block", block: { num: cur.num, flags: cur.flags, ok: m[1] === "end", lines: cur.lines } };
      }
      cur.lines.push(line);
      return null;
    }
    const b = /^%begin \d+ (\d+) (\d+)$/.exec(line);
    if (b) {
      this.current = { num: Number(b[1]), flags: Number(b[2]), lines: [] };
      return null;
    }
    const o = /^%output (%\d+) (.*)$/s.exec(line);
    if (o) return { kind: "output", pane: o[1], data: unescapeOutput(o[2]) };
    if (line.startsWith("%")) return { kind: "notice", line };
    return null;
  }
}

/**
 * 送った命令の待ち行列。応答は送った順に対応させ、番号（%begin の第2項）が直前に受けた番号より新しくない応答は対応させない。
 * tmux の番号はサーバー全体の通し番号で（ほかの client の命令が間に入り、飛び飛びになる）、送る前には予測できない。そのため「期待する番号」ではなく
 * 「前より新しいこと」で照合する（attach ごとに作り直す）。
 */
export class CommandQueue<T> {
  private readonly waiting: T[] = [];
  private lastNum = -1;
  enqueue(item: T): void {
    this.waiting.push(item);
  }
  /** 待ちに対応しない応答（attach 自身の応答）を受けた番号として覚える */
  markSeen(num: number): void {
    if (num > this.lastNum) this.lastNum = num;
  }
  /** 応答に対応する待ちを取り出す。待ちが無い・番号が新しくないなら undefined（呼び出し側がログに出して捨てる） */
  take(num: number): T | undefined {
    if (num <= this.lastNum) return undefined;
    const item = this.waiting.shift();
    if (item !== undefined) this.lastNum = num;
    return item;
  }
  get size(): number {
    return this.waiting.length;
  }
}

/** 先入れを作るために control client から取る値の並び（display の書式） */
export const DISPLAY_FORMAT =
  "#{pane_pid} #{alternate_on} #{history_size} #{cursor_x} #{cursor_y} #{cursor_flag} #{cursor_shape} #{cursor_blinking} #{alternate_saved_x} #{alternate_saved_y} #{keypad_flag} #{pane_height} #{pane_private_modes}";

export interface PaneInfo {
  pid: number;
  alternateOn: boolean;
  historySize: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  cursorShape: string;
  cursorBlinking: boolean;
  altSavedX: number;
  altSavedY: number;
  keypad: boolean;
  paneHeight: number;
  privateModes: number[];
}

const UNSET = 4294967295;

export function parsePaneInfo(line: string): PaneInfo | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 12) return null;
  const num = (s: string): number => (Number.isFinite(Number(s)) ? Number(s) : 0);
  const modes = (parts[12] ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => Number(s.replace(/^\?/, "")))
    .filter((n) => Number.isInteger(n) && n > 0);
  return {
    pid: num(parts[0]),
    alternateOn: parts[1] === "1",
    historySize: num(parts[2]),
    cursorX: num(parts[3]),
    cursorY: num(parts[4]),
    cursorVisible: parts[5] === "1",
    cursorShape: parts[6],
    cursorBlinking: parts[7] === "1",
    altSavedX: num(parts[8]),
    altSavedY: num(parts[9]),
    keypad: parts[10] === "1",
    paneHeight: num(parts[11]),
    privateModes: modes,
  };
}

/**
 * `capture-pane -p -e -S -`（履歴の先頭から可視の末尾まで 1 命令）の行を、末尾 paneHeight 行を可視、残りを履歴に分ける。
 * 実測（tmux 3.8）: 末尾の空行も落とされず、行数は history_size + pane_height になる。行数が paneHeight に満たない時は全てを可視にする。
 */
export function splitCapture(lines: string[], paneHeight: number): { history: string[]; visible: string[] } {
  const cut = Math.max(0, lines.length - Math.max(0, paneHeight));
  return { history: lines.slice(0, cut), visible: lines.slice(cut) };
}

/** DECSCUSR の値（カーソルの形と点滅） */
export function cursorStyleCode(shape: string, blinking: boolean): number {
  const base = shape === "block" ? 1 : shape === "underline" ? 3 : shape === "bar" ? 5 : null;
  if (base === null) return 0;
  return blinking ? base : base + 1;
}

/** 先入れでは触らないモード: 25（カーソルの表示は最後に決める）と alt 画面系（別に扱う） */
const SKIPPED_MODES = new Set([25, 47, 1047, 1048, 1049]);

export interface ReplayInput {
  info: PaneInfo;
  /** 履歴だけ（capture-pane -S - -E -1）。UTF-8 に戻した行 */
  history: string[];
  /** 通常画面の見えている部分（alt 中は -a、そうでなければ素のもの） */
  normal: string[];
  /** alt 画面の見えている部分（alt 中のみ） */
  alt: string[];
}

const ESC = "\x1b";

/** 先入れのバイト列。順: 画面を消す → 履歴＋通常画面 → (alt なら保存カーソル・1049h・alt 画面) → モード → keypad → カーソル形・位置・表示 */
export function buildReplay(input: ReplayInput): string {
  const { info } = input;
  let out = `${ESC}[H${ESC}[2J${ESC}[3J`;
  const joined = [...input.history, ...input.normal].join("\r\n");
  out += joined;
  if (info.alternateOn) {
    const sx = info.altSavedX === UNSET ? 0 : info.altSavedX;
    const sy = info.altSavedY === UNSET ? 0 : info.altSavedY;
    out += `${ESC}[${sy + 1};${sx + 1}H${ESC}[?1049h${ESC}[H${ESC}[2J`;
    out += input.alt.join("\r\n");
  }
  for (const mode of info.privateModes) {
    if (!SKIPPED_MODES.has(mode)) out += `${ESC}[?${mode}h`;
  }
  if (info.keypad) out += `${ESC}=`;
  out += `${ESC}[${cursorStyleCode(info.cursorShape, info.cursorBlinking)} q`;
  out += `${ESC}[${info.cursorY + 1};${info.cursorX + 1}H`;
  out += info.cursorVisible ? `${ESC}[?25h` : `${ESC}[?25l`;
  return out;
}
