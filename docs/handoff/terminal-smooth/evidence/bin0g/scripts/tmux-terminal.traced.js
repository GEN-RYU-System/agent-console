import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildReplay, classifyHasSession, CommandQueue, commonArgs, conditionalSendCommands, conditionalWritten, ControlParser, decodeLine, DISPLAY_FORMAT, paneTarget, parsePaneInfo, resizeCommand, sendKeysCommands, sessionTarget, splitCapture, } from "./tmux-protocol.js";
import { appendFileSync } from "node:fs";
// 便0c 測定用（/tmp の写しだけ）: 時刻の記録
const TRACE_FILE = process.env.AC_TRACE_FILE;
let traceBuf = [];
const tnow = () => (performance.timeOrigin + performance.now()).toFixed(2);
const trace = (k, n) => { if (TRACE_FILE) traceBuf.push(`${k} ${tnow()} ${n}`); };
if (TRACE_FILE) setInterval(() => { if (traceBuf.length) { appendFileSync(TRACE_FILE, traceBuf.join("\n") + "\n"); traceBuf = []; } }, 500).unref();
const MAX_ATTACH_ATTEMPTS = 3;
const REATTACH_INTERVAL_MS = 500;
const RELEASE_GRACE_MS = 2000;
/** つながるまで（つながらない間も）溜めておく入力の上限 */
const MAX_PENDING_WRITE_BYTES = 64 * 1024;
/** 条件付きの送りや問い合わせの応答を待つ上限（ms）。超えたら接続を取り直す */
const EXCHANGE_TIMEOUT_MS = 5000;
/** 1 本の control client（tmux -C attach）で、tmux の pane 1 つを端末として扱う */
export class TmuxControlTerminal {
    opts;
    pid;
    dataListeners = [];
    exitListeners = [];
    replayListeners = [];
    statusListeners = [];
    client = null;
    parser = new ControlParser();
    queue = new CommandQueue();
    decoder = new StringDecoder("utf8");
    ready = false;
    /** 先入れの最後の応答を受けるまでは true（その前の %output は先入れの中に入っているので捨てる） */
    replaying = false;
    pendingWrites = [];
    pendingBytes = 0;
    pendingSize = null;
    attempts = 0;
    released = false;
    exited = false;
    /** 接続を取り直し中（待ち行列を捨てた後、古い接続の応答を読まない）。attach で戻す */
    resetting = false;
    pane = "";
    interval;
    constructor(opts) {
        this.opts = opts;
        this.pid = opts.pid;
        this.interval = opts.reattachIntervalMs ?? REATTACH_INTERVAL_MS;
        this.attach();
    }
    onData(listener) {
        this.dataListeners.push(listener);
    }
    onExit(listener) {
        this.exitListeners.push(listener);
    }
    onReplay(listener) {
        this.replayListeners.push(listener);
    }
    onStatus(listener) {
        this.statusListeners.push(listener);
    }
    args(...rest) {
        return [...commonArgs(this.opts.ctx), ...rest];
    }
    attach() {
        if (this.released || this.exited)
            return;
        this.attempts += 1;
        this.parser = new ControlParser();
        for (const w of this.queue.drain())
            w.abort?.();
        this.queue = new CommandQueue();
        this.decoder = new StringDecoder("utf8");
        this.ready = false;
        this.replaying = false;
        this.resetting = false;
        const client = spawn(this.opts.ctx.tmux, this.args("-C", "attach-session", "-E", "-t", sessionTarget(this.opts.name)), {
            stdio: ["pipe", "pipe", "pipe"],
            env: this.opts.env,
        });
        this.client = client;
        client.stdout?.on("data", (chunk) => {
            if (this.client !== client)
                return;
            trace("C", chunk.length);
            for (const ev of this.parser.push(chunk))
                this.handle(ev);
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
            if (this.client !== client)
                return;
            this.client = null;
            void this.onClientClosed();
        });
    }
    handle(ev) {
        if (ev.kind === "output") {
            if (!this.pane)
                this.pane = ev.pane;
            if (this.replaying)
                return;
            const text = this.decoder.write(ev.data);
            if (text.length > 0)
                trace("O", `${text.length} ${text.split("\x1b[?2026h").length - 1} ${text.split("\x1b[?2026l").length - 1}`);
            if (text.length > 0)
                for (const l of this.dataListeners)
                    l(text);
            return;
        }
        if (ev.kind === "block") {
            if (this.resetting)
                return;
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
    onReady() {
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
        const got = [];
        for (let i = 0; i < commands.length; i++) {
            this.queue.enqueue({
                resolve: (b) => {
                    got.push(b);
                    if (got.length === commands.length)
                        this.finishReplay(got[0], got[1], got[2]);
                },
            });
        }
        this.client?.stdin?.write(`${commands.join("\n")}\n`);
    }
    finishReplay(info, capture, altNormal) {
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
        if (parsed.pid > 0)
            this.pid = parsed.pid;
        const text = (b) => (b.ok ? b.lines.map(decodeLine) : []);
        // 1 本の capture を、末尾 pane_height 行（可視）とそれより前（履歴）に分ける
        const { history, visible } = splitCapture(text(capture), parsed.paneHeight);
        const replay = buildReplay({
            info: parsed,
            history,
            normal: parsed.alternateOn ? text(altNormal) : visible,
            alt: parsed.alternateOn ? visible : [],
        });
        for (const l of this.replayListeners)
            l(replay);
        this.setConnected();
        this.flushPending();
    }
    flushPending() {
        const size = this.pendingSize;
        this.pendingSize = null;
        if (size)
            this.sendNow(resizeCommand(size.cols, size.rows));
        const writes = this.pendingWrites;
        this.pendingWrites = [];
        this.pendingBytes = 0;
        for (const w of writes)
            this.writeNow(w);
    }
    setConnected() {
        for (const l of this.statusListeners)
            l("connected");
    }
    sendNow(line) {
        this.queue.enqueue({ resolve: (b) => !b.ok && this.opts.logger.warn(`tmux command failed (${this.opts.name}): ${b.lines.join(" ").slice(0, 200)}`) });
        this.client?.stdin?.write(`${line}\n`);
    }
    writeNow(data) {
        trace("W", data.length);
        for (const cmd of sendKeysCommands(this.opts.name, data))
            this.sendNow(cmd);
    }
    write(data) {
        if (this.exited || this.released)
            return;
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
    writeState() {
        const writable = this.ready && !this.replaying && !this.resetting && this.client !== null && !this.exited && !this.released;
        return { writable, pending: this.pendingWrites.length };
    }
    /** 待ち行列を捨てて接続を取り直す。残った待ちが次の命令の応答を取らないようにする。待っていた呼び出しは失敗で返す */
    resetConnection() {
        this.resetting = true;
        this.ready = false;
        this.replaying = false;
        for (const w of this.queue.drain())
            w.abort?.();
        const client = this.client;
        if (!client)
            return;
        try {
            client.stdin?.end();
        }
        catch {
            /* すでに閉じている */
        }
        try {
            client.kill();
        }
        catch {
            /* すでに終わっている */
        }
    }
    /** 1 命令を送り、応答を count 個待つ。待ちの途中で接続が取り直されたら null。1 つ目が失敗（%error）のときは、残りの応答が来ないことがあるので接続を取り直す */
    exchange(line, count) {
        return new Promise((resolve) => {
            const got = [];
            let done = false;
            const finish = (result) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => {
                finish(null);
                this.resetConnection();
            }, EXCHANGE_TIMEOUT_MS);
            for (let i = 0; i < count; i++) {
                this.queue.enqueue({
                    resolve: (b) => {
                        got.push(b);
                        if (!b.ok && got.length < count) {
                            finish(got);
                            this.resetConnection();
                            return;
                        }
                        if (got.length === count)
                            finish(got);
                    },
                    abort: () => finish(null),
                });
            }
            this.client?.stdin?.write(`${line}\n`);
        });
    }
    async sendToPane(pane, pid, data) {
        let commands;
        try {
            commands = conditionalSendCommands(pane, pid, data);
        }
        catch {
            return { written: false, reason: "invalid" };
        }
        // 1 本ずつ、2 つの応答がそろってから次を送る。どれか 1 本でも「書いた」と読めなければ、そこで止める
        for (const cmd of commands) {
            if (!this.writeState().writable)
                return { written: false, reason: "not_writable" };
            const blocks = await this.exchange(cmd, 2);
            if (blocks === null)
                return { written: false, reason: "no_response" };
            if (blocks.length < 2 || !conditionalWritten(blocks[0], blocks[1]))
                return { written: false, reason: "not_written" };
        }
        return { written: true };
    }
    async queryPanePid(pane) {
        if (!/^%\d+$/.test(pane) || !this.writeState().writable)
            return null;
        const blocks = await this.exchange(`display -p -t ${pane} '#{pane_pid}'`, 1);
        if (blocks === null || !blocks[0].ok || blocks[0].lines.length !== 1)
            return null;
        const pid = Number(blocks[0].lines[0].trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    resize(cols, rows) {
        if (this.exited || this.released)
            return;
        if (!this.ready || this.replaying || !this.client) {
            this.pendingSize = { cols, rows };
            return;
        }
        this.sendNow(resizeCommand(cols, rows));
    }
    async hasSession() {
        return new Promise((resolve) => {
            const p = spawn(this.opts.ctx.tmux, this.args("has-session", "-t", sessionTarget(this.opts.name)), { stdio: ["ignore", "ignore", "pipe"], env: this.opts.env });
            let err = "";
            p.stderr?.on("data", (c) => (err += c.toString("utf8")));
            p.on("error", () => resolve("unreachable"));
            p.on("close", (code) => resolve(classifyHasSession(code, err)));
        });
    }
    emitExit() {
        if (this.exited)
            return;
        this.exited = true;
        for (const l of this.exitListeners)
            l({ exitCode: 0 });
    }
    async onClientClosed() {
        if (this.released || this.exited)
            return;
        const result = await this.hasSession();
        if (this.released || this.exited)
            return;
        if (result === "gone") {
            this.emitExit();
            return;
        }
        // alive も unreachable も exited にはしない。つなぎ直し（最大 3 回）
        if (this.attempts >= MAX_ATTACH_ATTEMPTS) {
            this.opts.logger.warn(`tmux: cannot attach to ${this.opts.name} (${result})`);
            for (const l of this.statusListeners)
                l("failed");
            return;
        }
        setTimeout(() => this.attach(), this.interval);
    }
    kill() {
        if (this.exited)
            return;
        const p = spawn(this.opts.ctx.tmux, this.args("kill-session", "-t", sessionTarget(this.opts.name)), { stdio: "ignore", env: this.opts.env });
        p.on("error", () => undefined);
        p.on("close", () => {
            void this.hasSession().then((r) => {
                if (r === "gone")
                    this.emitExit();
            });
        });
    }
    release() {
        if (this.released)
            return;
        this.released = true;
        const client = this.client;
        if (!client)
            return;
        try {
            client.stdin?.end();
        }
        catch {
            /* すでに閉じている */
        }
        const timer = setTimeout(() => {
            try {
                client.kill("SIGKILL");
            }
            catch {
                /* すでに終わっている */
            }
        }, RELEASE_GRACE_MS);
        timer.unref();
        client.on("close", () => clearTimeout(timer));
    }
}
