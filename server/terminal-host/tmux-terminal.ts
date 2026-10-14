import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  buildReplay,
  classifyHasSession,
  CommandQueue,
  commonArgs,
  ControlParser,
  decodeLine,
  DISPLAY_FORMAT,
  paneTarget,
  parsePaneInfo,
  resizeCommand,
  sendKeysCommands,
  sessionTarget,
  splitCapture,
  type ControlBlock,
  type ControlEvent,
  type HasSessionResult,
} from "./tmux-protocol.ts";
import type { TerminalHandle, TerminalLogger, TmuxContext } from "./types.ts";

const MAX_ATTACH_ATTEMPTS = 3;
const REATTACH_INTERVAL_MS = 500;
const RELEASE_GRACE_MS = 2000;
/** つながるまで（つながらない間も）溜めておく入力の上限 */
const MAX_PENDING_WRITE_BYTES = 64 * 1024;

export interface TmuxTerminalOptions {
  ctx: TmuxContext;
  /** セッション名（ac-<id>） */
  name: string;
  /** 分かっている pane の pid。つなげない間は 0 */
  pid: number;
  env: Record<string, string>;
  logger: TerminalLogger;
  reattachIntervalMs?: number;
}

interface Waiter {
  resolve(block: ControlBlock): void;
}

/** 1 本の control client（tmux -C attach）で、tmux の pane 1 つを端末として扱う */
export class TmuxControlTerminal implements TerminalHandle {
  pid: number;
  private readonly dataListeners: Array<(d: string) => void> = [];
  private readonly exitListeners: Array<(e: { exitCode: number }) => void> = [];
  private readonly replayListeners: Array<(d: string) => void> = [];
  private readonly statusListeners: Array<(s: "connected" | "failed") => void> = [];
  private client: ChildProcess | null = null;
  private parser = new ControlParser();
  private queue = new CommandQueue<Waiter>();
  private decoder = new StringDecoder("utf8");
  private ready = false;
  /** 先入れの最後の応答を受けるまでは true（その前の %output は先入れの中に入っているので捨てる） */
  private replaying = false;
  private pendingWrites: string[] = [];
  private pendingBytes = 0;
  private pendingSize: { cols: number; rows: number } | null = null;
  private attempts = 0;
  private released = false;
  private exited = false;
  private pane = "";
  private readonly interval: number;

  constructor(private readonly opts: TmuxTerminalOptions) {
    this.pid = opts.pid;
    this.interval = opts.reattachIntervalMs ?? REATTACH_INTERVAL_MS;
    this.attach();
  }

  onData(listener: (d: string) => void): void {
    this.dataListeners.push(listener);
  }
  onExit(listener: (e: { exitCode: number }) => void): void {
    this.exitListeners.push(listener);
  }
  onReplay(listener: (d: string) => void): void {
    this.replayListeners.push(listener);
  }
  onStatus(listener: (s: "connected" | "failed") => void): void {
    this.statusListeners.push(listener);
  }

  private args(...rest: string[]): string[] {
    return [...commonArgs(this.opts.ctx), ...rest];
  }

  private attach(): void {
    if (this.released || this.exited) return;
    this.attempts += 1;
    this.parser = new ControlParser();
    this.queue = new CommandQueue<Waiter>();
    this.decoder = new StringDecoder("utf8");
    this.ready = false;
    this.replaying = false;
    const client = spawn(this.opts.ctx.tmux, this.args("-C", "attach-session", "-E", "-t", sessionTarget(this.opts.name)), {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.opts.env,
    });
    this.client = client;
    client.stdout?.on("data", (chunk: Buffer) => {
      if (this.client !== client) return;
      for (const ev of this.parser.push(chunk)) this.handle(ev);
    });
    client.stderr?.on("data", () => {
      /* 失敗は終了後の has-session で振り分ける */
    });
    client.stdin?.on("error", () => {
      /* 終了中の書き込み。終了の扱いは close で行う */
    });
    client.on("error", (err) => {
      this.opts.logger.warn(`tmux client error (${this.opts.name}): ${err.message}`);
    });
    client.on("close", () => {
      if (this.client !== client) return;
      this.client = null;
      void this.onClientClosed();
    });
  }

  private handle(ev: ControlEvent): void {
    if (ev.kind === "output") {
      if (!this.pane) this.pane = ev.pane;
      if (this.replaying) return;
      const text = this.decoder.write(ev.data);
      if (text.length > 0) for (const l of this.dataListeners) l(text);
      return;
    }
    if (ev.kind === "block") {
      if (!this.ready) {
        this.ready = true;
        this.queue.markSeen(ev.block.num);
        this.onReady();
        return;
      }
      const waiter = this.queue.take(ev.block.num);
      if (!waiter) {
        this.opts.logger.warn(`tmux: unexpected or out-of-order block ${ev.block.num} dropped (${this.opts.name})`);
        return;
      }
      waiter.resolve(ev.block);
    }
    // notice（%exit など）は client の終了で扱う
  }

  private onReady(): void {
    this.replaying = true;
    const t = paneTarget(this.opts.name);
    // 先入れの命令は 1 回の write で詰めて送る（途中に出力が割り込まない）
    const commands = [
      `display -p -t ${t} '${DISPLAY_FORMAT}'`,
      // 履歴の先頭から可視の末尾までを 1 命令で取る（履歴と可視を別命令にすると、間に流れた行が欠ける）
      `capture-pane -p -e -S - -t ${t}`,
      `capture-pane -p -e -a -q -t ${t}`,
    ];
    // 3 本目の応答を受けた同じ同期処理の中で先入れを終える（同じ塊の後ろの %output を捨てず、先入れの後ろに流す）
    const got: ControlBlock[] = [];
    for (let i = 0; i < commands.length; i++) {
      this.queue.enqueue({
        resolve: (b) => {
          got.push(b);
          if (got.length === commands.length) this.finishReplay(got[0], got[1], got[2]);
        },
      });
    }
    this.client?.stdin?.write(`${commands.join("\n")}\n`);
  }

  private finishReplay(info: ControlBlock, capture: ControlBlock, altNormal: ControlBlock): void {
    const parsed = info.ok && info.lines.length > 0 ? parsePaneInfo(decodeLine(info.lines[0])) : null;
    // つなぎ直しが済んだ（先入れまで届いた）ので、再試行の回数を戻す。最初の応答だけでは戻さない
    this.attempts = 0;
    // 先入れが作れなくても、ここから先の出力は流す
    this.replaying = false;
    if (!parsed) {
      this.opts.logger.warn(`tmux: could not read pane info (${this.opts.name})`);
      this.setConnected();
      this.flushPending();
      return;
    }
    if (parsed.pid > 0) this.pid = parsed.pid;
    const text = (b: ControlBlock): string[] => (b.ok ? b.lines.map(decodeLine) : []);
    // 1 本の capture を、末尾 pane_height 行（可視）とそれより前（履歴）に分ける
    const { history, visible } = splitCapture(text(capture), parsed.paneHeight);
    const replay = buildReplay({
      info: parsed,
      history,
      normal: parsed.alternateOn ? text(altNormal) : visible,
      alt: parsed.alternateOn ? visible : [],
    });
    for (const l of this.replayListeners) l(replay);
    this.setConnected();
    this.flushPending();
  }

  private flushPending(): void {
    const size = this.pendingSize;
    this.pendingSize = null;
    if (size) this.sendNow(resizeCommand(size.cols, size.rows));
    const writes = this.pendingWrites;
    this.pendingWrites = [];
    this.pendingBytes = 0;
    for (const w of writes) this.writeNow(w);
  }

  private setConnected(): void {
    for (const l of this.statusListeners) l("connected");
  }

  private sendNow(line: string): void {
    this.queue.enqueue({ resolve: (b) => !b.ok && this.opts.logger.warn(`tmux command failed (${this.opts.name}): ${b.lines.join(" ").slice(0, 200)}`) });
    this.client?.stdin?.write(`${line}\n`);
  }

  private writeNow(data: string): void {
    for (const cmd of sendKeysCommands(this.opts.name, data)) this.sendNow(cmd);
  }

  write(data: string): void {
    if (this.exited || this.released) return;
    if (!this.ready || this.replaying || !this.client) {
      const size = Buffer.byteLength(data);
      if (this.pendingBytes + size > MAX_PENDING_WRITE_BYTES) {
        // 古い入力は捨てず、新しい入力を断る
        this.opts.logger.warn(`tmux: pending input is over ${MAX_PENDING_WRITE_BYTES} bytes, new input refused (${this.opts.name})`);
        return;
      }
      this.pendingBytes += size;
      this.pendingWrites.push(data);
      return;
    }
    this.writeNow(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.released) return;
    if (!this.ready || this.replaying || !this.client) {
      this.pendingSize = { cols, rows };
      return;
    }
    this.sendNow(resizeCommand(cols, rows));
  }

  private async hasSession(): Promise<HasSessionResult> {
    return new Promise((resolve) => {
      const p = spawn(this.opts.ctx.tmux, this.args("has-session", "-t", sessionTarget(this.opts.name)), { stdio: ["ignore", "ignore", "pipe"], env: this.opts.env });
      let err = "";
      p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
      p.on("error", () => resolve("unreachable"));
      p.on("close", (code) => resolve(classifyHasSession(code, err)));
    });
  }

  private emitExit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const l of this.exitListeners) l({ exitCode: 0 });
  }

  private async onClientClosed(): Promise<void> {
    if (this.released || this.exited) return;
    const result = await this.hasSession();
    if (this.released || this.exited) return;
    if (result === "gone") {
      this.emitExit();
      return;
    }
    // alive も unreachable も exited にはしない。つなぎ直し（最大 3 回）
    if (this.attempts >= MAX_ATTACH_ATTEMPTS) {
      this.opts.logger.warn(`tmux: cannot attach to ${this.opts.name} (${result})`);
      for (const l of this.statusListeners) l("failed");
      return;
    }
    setTimeout(() => this.attach(), this.interval);
  }

  kill(): void {
    if (this.exited) return;
    const p = spawn(this.opts.ctx.tmux, this.args("kill-session", "-t", sessionTarget(this.opts.name)), { stdio: "ignore", env: this.opts.env });
    p.on("error", () => undefined);
    p.on("close", () => {
      void this.hasSession().then((r) => {
        if (r === "gone") this.emitExit();
      });
    });
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const client = this.client;
    if (!client) return;
    try {
      client.stdin?.end();
    } catch {
      /* すでに閉じている */
    }
    const timer = setTimeout(() => {
      try {
        client.kill("SIGKILL");
      } catch {
        /* すでに終わっている */
      }
    }, RELEASE_GRACE_MS);
    timer.unref();
    client.on("close", () => clearTimeout(timer));
  }
}
