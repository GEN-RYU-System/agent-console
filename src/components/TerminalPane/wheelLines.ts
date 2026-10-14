// マウス追跡中の端末（Claude など）へ送るホイールの量を「行の数」に直し、1 行 1 信号で少しずつ送るための部品。
// 設計の正本: docs/handoff/terminal-wheel/design.md（§12 が最優先）

/** 1 フレームで送る行数 */
export const LINES_PER_FRAME = 2;

export interface WheelDelta {
  deltaY: number;
  /** 0: ピクセル / 1: 行 / 2: ページ（WheelEvent.deltaMode と同じ） */
  deltaMode: number;
}

/** 1 イベントで送る行数の上限（画面 1 枚分。暴走を防ぐ） */
export const maxLinesPerEvent = (rows: number): number => Math.max(1, rows);
/** まだ送っていない行に対する上限（画面 2 枚分） */
export const queueLimit = (rows: number): number => Math.max(1, rows) * 2;

/** ホイールの量を行数（符号付き整数）にし、1 行に満たない端数は持ち越す。向きが変わったら端数を捨てる。 */
export class WheelLineAccumulator {
  private fraction = 0;

  add(e: WheelDelta, cellHeightPx: number, rows: number): number {
    if (!(cellHeightPx > 0) || e.deltaY === 0 || !Number.isFinite(e.deltaY)) return 0;
    const lines = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * rows : e.deltaY / cellHeightPx;
    if (this.fraction !== 0 && Math.sign(this.fraction) !== Math.sign(lines)) this.fraction = 0;
    const total = this.fraction + lines;
    const whole = Math.trunc(total);
    this.fraction = total - whole;
    const cap = maxLinesPerEvent(rows);
    return Math.max(-cap, Math.min(cap, whole));
  }

  reset(): void {
    this.fraction = 0;
  }
}

export type Direction = 1 | -1;

/** 送る行の待ち行列。フレームごとに最大 LINES_PER_FRAME 行ずつ emitOne を呼ぶ。送る時機は注入する（本番は requestAnimationFrame）。 */
export class LineEmitter {
  private pending = 0;
  private dir: Direction = 1;
  private emitOne: ((dir: Direction) => void) | null = null;
  private scheduled = false;

  constructor(
    private readonly schedule: (cb: () => void) => void,
    private readonly cancel: () => void,
  ) {}

  /** lines は符号付き整数。逆向きなら待ち行列を捨てて入れ替える。rows は未送出の上限（rows × 2）の元 */
  push(lines: number, emitOne: (dir: Direction) => void, rows: number): void {
    if (lines === 0) return;
    const dir: Direction = lines > 0 ? 1 : -1;
    if (this.pending > 0 && dir !== this.dir) this.pending = 0;
    this.dir = dir;
    this.emitOne = emitOne;
    const room = Math.max(0, queueLimit(rows) - this.pending);
    this.pending += Math.min(Math.abs(lines), room);
    this.arm();
  }

  /** 待ち行列を空にする（送る時機の予約も止める） */
  clear(): void {
    this.pending = 0;
    if (this.scheduled) {
      this.scheduled = false;
      this.cancel();
    }
  }

  dispose(): void {
    this.clear();
    this.emitOne = null;
  }

  get queued(): number {
    return this.pending;
  }

  private arm(): void {
    if (this.scheduled || this.pending <= 0) return;
    this.scheduled = true;
    this.schedule(() => this.tick());
  }

  private tick(): void {
    this.scheduled = false;
    const emit = this.emitOne;
    if (emit === null) return;
    const n = Math.min(LINES_PER_FRAME, this.pending);
    for (let i = 0; i < n; i++) {
      // emit の中で clear / dispose された場合は残りを送らない
      if (this.pending <= 0) break;
      this.pending -= 1;
      emit(this.dir);
    }
    this.arm();
  }
}
