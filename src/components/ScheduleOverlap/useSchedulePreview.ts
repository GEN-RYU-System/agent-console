import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";
import type { SchedulePreview } from "../../types";

const WAIT_MS = 300;

/** enabled の間、key が変わるたびに 300ms 待って ask を呼ぶ。古い答えは捨てる。400 は入力の途中として何も出さない */
export function useSchedulePreview(enabled: boolean, key: string, ask: () => Promise<SchedulePreview>): { preview: SchedulePreview | null; failed: boolean } {
  const [state, setState] = useState<{ preview: SchedulePreview | null; failed: boolean }>({ preview: null, failed: false });
  const seq = useRef(0);
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    const n = ++seq.current;
    if (!enabled) { setState({ preview: null, failed: false }); return undefined; }
    const timer = setTimeout(() => {
      askRef.current().then(
        (preview) => { if (seq.current === n) setState({ preview, failed: false }); },
        (e: unknown) => { if (seq.current === n) setState(e instanceof ApiError && e.status === 400 ? { preview: null, failed: false } : { preview: null, failed: true }); },
      );
    }, WAIT_MS);
    return () => clearTimeout(timer);
  }, [enabled, key]);
  return state;
}
