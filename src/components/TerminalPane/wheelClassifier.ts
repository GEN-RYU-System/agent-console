/**
 * ホイールの入力が「物理的なマウスのホイール」か（それ以外はトラックパッドなど）を見分ける。
 * VS Code の MouseWheelClassifier（microsoft/vscode: src/vs/base/browser/ui/scrollbar/scrollableElement.ts）と同じ考え方。
 * 直近 5 件の score を、新しいものほど重く（1/2, 1/4, …）足して、0.5 以下なら物理ホイールとする。
 */

const CAPACITY = 5;
const PHYSICAL_THRESHOLD = 0.5;
const BASE_SCORE = 0.5;
const NON_INTEGER_PENALTY = 0.25;
const ACCELERATION_BONUS = 0.5;
/** 整数とみなす誤差 */
const INTEGER_TOLERANCE = 0.01;
/** WheelEvent.wheelDelta の 1 ノッチ */
const WHEEL_DELTA_PER_NOTCH = 120;
/** ピクセル単位の deltaY を VS Code と同じ尺度にする割り方 */
const PIXELS_PER_UNIT = 40;
const DOM_DELTA_LINE = 1;

interface WheelSample {
  readonly dx: number;
  readonly dy: number;
  readonly score: number;
}

const isAlmostInt = (v: number): boolean => Math.abs(Math.round(v) - v) < INTEGER_TOLERANCE;

function computeScore(dx: number, dy: number, previous: WheelSample | undefined): number {
  // 縦と横が同時に動く → 物理ホイールではない
  if (Math.abs(dx) > 0 && Math.abs(dy) > 0) return 1;
  let score = BASE_SCORE;
  if (!isAlmostInt(dx) || !isAlmostInt(dy)) score += NON_INTEGER_PENALTY;
  if (previous) {
    // 加速しない（直前の値の倍数になっている）→ 物理ホイール。0 での割り算を避けるため、小さい方は 1 以上にする
    const [ax, ay] = [Math.abs(dx), Math.abs(dy)];
    const [px, py] = [Math.abs(previous.dx), Math.abs(previous.dy)];
    const minX = Math.max(Math.min(ax, px), 1);
    const minY = Math.max(Math.min(ay, py), 1);
    if (Math.max(ax, px) % minX === 0 && Math.max(ay, py) % minY === 0) score -= ACCELERATION_BONUS;
  }
  return Math.min(Math.max(score, 0), 1);
}

export class WheelClassifier {
  private samples: readonly WheelSample[] = [];

  /** timestamp は VS Code の形に合わせた引数で、判定には使わない */
  accept(_timestamp: number, dx: number, dy: number): void {
    const score = computeScore(dx, dy, this.samples.at(-1));
    this.samples = [...this.samples, { dx, dy, score }].slice(-CAPACITY);
  }

  isPhysicalMouseWheel(): boolean {
    if (this.samples.length === 0) return false;
    let remaining = 1;
    let score = 0;
    for (let i = this.samples.length - 1, n = 1; i >= 0; i--, n++) {
      const influence = i === 0 ? remaining : Math.pow(2, -n);
      remaining -= influence;
      score += this.samples[i].score * influence;
    }
    return score <= PHYSICAL_THRESHOLD;
  }
}

/** wheel イベントの縦横の量を、VS Code の StandardWheelEvent と同じ尺度（マウスの 1 ノッチ = 1）にする。 */
export function wheelDeltas(e: WheelEvent): { dx: number; dy: number } {
  const legacy = e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
  const axis = (legacyValue: number | undefined, delta: number): number => {
    if (typeof legacyValue === "number") return legacyValue / WHEEL_DELTA_PER_NOTCH;
    return e.deltaMode === DOM_DELTA_LINE ? -delta : -delta / PIXELS_PER_UNIT;
  };
  return { dx: axis(legacy.wheelDeltaX, e.deltaX), dy: axis(legacy.wheelDeltaY, e.deltaY) };
}
