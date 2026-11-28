export const SYNC_FRAME_HOLD_MS = 100;

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";

export function createSyncFrameCoalescer(
  write: (data: string) => void,
  holdMs = SYNC_FRAME_HOLD_MS,
): { push(data: string): void; reset(): void; dispose(): void } {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const emit = (data: string): void => {
    if (data !== "") write(data);
  };

  // buf の末尾が BEGIN の頭（1〜7 文字）と同じなら、その長さを返す。無ければ 0
  const partialBeginLength = (buf: string): number => {
    for (let n = BEGIN.length - 1; n >= 1; n--) {
      if (buf.length >= n && buf.endsWith(BEGIN.slice(0, n))) return n;
    }
    return 0;
  };

  const push = (data: string): void => {
    const prev = pending;
    const buf = pending + data;
    const h = buf.lastIndexOf(BEGIN);
    const l = buf.lastIndexOf(END);
    if (h > l) {
      emit(buf.slice(0, h));
      pending = buf.slice(h);
    } else {
      const n = partialBeginLength(buf);
      if (n > 0) {
        emit(buf.slice(0, buf.length - n));
        pending = buf.slice(buf.length - n);
      } else {
        emit(buf);
        pending = "";
      }
    }
    if (pending === "") {
      clearTimer();
    } else {
      // 前回から続く同じ絵（前の pending が BEGIN 始まりで、今回も先頭の BEGIN を貯めている）
      // のときだけ時計を続ける。新しい絵を貯め始めたら時計をかけ直す
      const sameFrame = prev.startsWith(BEGIN) && pending.startsWith(BEGIN) && h === 0;
      if (!sameFrame) clearTimer();
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          const rest = pending;
          pending = "";
          emit(rest);
        }, holdMs);
      }
    }
  };

  const reset = (): void => {
    pending = "";
    clearTimer();
  };

  return { push, reset, dispose: reset };
}
