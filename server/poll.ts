/** 前回の完了後に次を予約する周期実行。多重起動せず、例外は onError に渡して継続する。 */
export function startPolling(task: () => Promise<void>, intervalMs: number, onError: (err: unknown) => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    try {
      await task();
    } catch (err) {
      onError(err);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
