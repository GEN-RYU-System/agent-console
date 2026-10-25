import type { NotificationSender } from "./notify.ts";

/** 設計 discord-pdca §4-4: 送れなければ 30秒・2分・10分のあとに1回ずつやり直し、それでも駄目なら macOS の通知へ */
export const NOTIFY_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
export const NOTIFY_QUEUE_LIMIT = 50;

export interface DiscordNotifierDeps {
  webhookUrl: string | null;
  send: (url: string, content: string) => Promise<{ ok: boolean }>;
  macos: NotificationSender | null;
  setTimer: (f: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

export class DiscordNotifier {
  private readonly queue: string[] = [];
  private busy = false;
  private stopped = false;
  private timer: unknown = null;

  constructor(private readonly deps: DiscordNotifierDeps) {}

  /** 待たない。待ち行列の末尾に足す（本文は呼び出し側が決まった文だけを渡す） */
  notify(text: string): void {
    if (this.stopped) return;
    if (this.deps.webhookUrl === null || this.queue.length >= NOTIFY_QUEUE_LIMIT) {
      this.fallback(text);
      return;
    }
    this.queue.push(text);
    void this.pump();
  }

  /** 待っているやり直しのタイマーを止め、待ち行列を捨てる */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.queue.length = 0;
  }

  private fallback(text: string): void {
    this.deps.macos?.(text);
  }

  private async attempt(url: string, text: string): Promise<boolean> {
    try {
      return (await this.deps.send(url, text)).ok;
    } catch {
      return false;
    }
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const text = this.queue[0] as string;
        const url = this.deps.webhookUrl as string;
        let sent = await this.attempt(url, text);
        for (let i = 0; !sent && !this.stopped && i < NOTIFY_RETRY_DELAYS_MS.length; i++) {
          await new Promise<void>((resolve) => {
            this.timer = this.deps.setTimer(() => { this.timer = null; resolve(); }, NOTIFY_RETRY_DELAYS_MS[i] as number);
          });
          if (this.stopped) break;
          sent = await this.attempt(url, text);
        }
        if (this.stopped) break;
        this.queue.shift();
        if (!sent) {
          console.error("discord-notify: failed after retries");
          this.fallback(text);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
