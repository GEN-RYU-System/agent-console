// 件のセッションの外への通信を受ける 1 か所（受付）。設計 room-design §4-4。agent-console サーバーの中で動く。
// 受けるのは `CONNECT host:443` だけ。通す行き先は caseProxyDomains() の完全一致だけで、api.anthropic.com は件の本体の pid からの接続だけ通す。
// TLS は開かず、通すときは両方向に流すだけ。1 回ごとに監査記録に 1 行書く。
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { isActivitySetupEnabled } from "./activity-setup.ts";
import { CASE_MAIN_ONLY_DOMAINS, CASE_PROXY_PORT } from "./case-sandbox.ts";
import type { RoutineAuditEntry } from "./routine-audit.ts";

const execFileAsync = promisify(execFile);

const LSOF_BIN = "/usr/sbin/lsof";
const LOOKUP_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 15000;

/** 件の本体の記録（pid と、ps -o lstart= の開始時刻。pid の使い回しを見分ける） */
export interface MainProcess {
  pid: number;
  lstart: string;
}
export type MainOf = () => ReadonlyMap<string, MainProcess>;
/** 送り元の番号（127.0.0.1 側）から、その番号を持つ全プロセスの pid を引く（接続の両端が出るので、サーバー自身も入る） */
export type LookupPid = (sourcePort: number) => Promise<number[]>;

/** 本物の lsof で引く。`lsof -nP -Fp -iTCP@127.0.0.1:<番号>` の p 行。引けなければ空 */
export const lookupPidByLsof: LookupPid = async (sourcePort) => {
  try {
    const { stdout } = await execFileAsync(LSOF_BIN, ["-nP", "-Fp", `-iTCP@127.0.0.1:${sourcePort}`], { timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    return stdout
      .split("\n")
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => Number(line.slice(1)));
  } catch {
    // lsof は 1 件も無いと終了コード 1 を返す。どの失敗も「引けない」
    return [];
  }
};

/** サーバー自身の pid を除いて残りがちょうど 1 つならその pid。0 件・2 つ以上は null */
export const singleOtherPid = (pids: readonly number[]): number | null => {
  const rest = [...new Set(pids)].filter((pid) => pid !== process.pid);
  return rest.length === 1 ? rest[0] : null;
};

const PS_BIN = "ps";

/** `ps -o lstart= -p <pid>` の答え（前後の空白を除く）。引けなければ null */
export async function readLstart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(PS_BIN, ["-o", "lstart=", "-p", String(pid)], { timeout: LOOKUP_TIMEOUT_MS });
    const out = stdout.trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** 同期版（件の本体を記録するとき）。引けなければ null */
export function readLstartSync(pid: number): string | null {
  try {
    const out = execFileSync(PS_BIN, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** pid と開始時刻がどれかの件の本体の記録と一致すれば、その件のセッション id */
export function sessionOfMain(pid: number, lstart: string | null, mains: ReadonlyMap<string, MainProcess>): string | null {
  if (lstart === null) return null;
  for (const [id, main] of mains) if (main.pid === pid && main.lstart === lstart) return id;
  return null;
}

/** 送り元の番号から、件の本体の pid を引く。親はたどらない。件の本体と一致したときだけ件のセッション id */
export async function mainSessionOfSourcePort(sourcePort: number, mains: ReadonlyMap<string, MainProcess>, lookupPid: LookupPid): Promise<string | null> {
  if (mains.size === 0) return null;
  const pid = singleOtherPid(await lookupPid(sourcePort));
  if (pid === null) return null;
  return sessionOfMain(pid, await readLstart(pid), mains);
}

/** macOS の版を読む（`sw_vers -productVersion`）。読めなければ null */
export async function readProductVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("sw_vers", ["-productVersion"], { timeout: LOOKUP_TIMEOUT_MS });
    const v = stdout.trim();
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

export const CASE_ROOM_MACOS_FILE = "case-room-macos.json";

/** 記録（`<dataDir>/case-room-macos.json` の productVersion）が今の版と同じか。記録が無い・違う・読めない・今の版が読めないときは false */
export function caseRoomMacosAccepted(dataDir: string, current: string | null): boolean {
  if (current === null) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dataDir, CASE_ROOM_MACOS_FILE), "utf8"));
    return typeof parsed === "object" && parsed !== null && (parsed as { productVersion?: unknown }).productVersion === current;
  } catch {
    return false;
  }
}

export type CaseProxyVerdict = { ok: true; host: string } | { ok: false; host: string };

/** CONNECT の宛先（`host:port`）を整える。host は小文字にして末尾の点を 1 つ落とす。IP の直書き・ASCII でない名前・空・443 以外は拒否 */
export function normalizeConnectTarget(target: string, domains: ReadonlySet<string>): CaseProxyVerdict {
  const bracketed = target.startsWith("[");
  const split = target.lastIndexOf(":");
  const rawHost = split < 0 ? target : target.slice(0, split);
  const port = split < 0 ? "" : target.slice(split + 1);
  let host = rawHost.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  // eslint-disable-next-line no-control-regex
  const asciiOnly = /^[\x21-\x7e]+$/.test(host);
  if (bracketed || host === "" || !asciiOnly || net.isIP(host) !== 0 || port !== "443" || !domains.has(host)) return { ok: false, host };
  return { ok: true, host };
}

export interface CaseProxyOptions {
  port?: number;
  domains: readonly string[];
  mainOf: MainOf;
  audit: (entry: RoutineAuditEntry) => Promise<void> | void;
  lookupPid?: LookupPid;
  /** 試験用: 環境変数（既定 process.env）。AGENT_CONSOLE_PORT があれば起こさない */
  env?: Readonly<Record<string, string | undefined>>;
  /** 試験用: 相手へのつなぎ方 */
  dial?: (host: string, port: number) => net.Socket;
}

export interface CaseProxy {
  /** 待ち受けが始まったら（または失敗したら・起こさないときは今すぐ）解ける */
  ready: Promise<void>;
  isListening(): boolean;
  close(): Promise<void>;
}

const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const BAD_REQUEST = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/**
 * 受付を起こす。本番の番号のサーバーのときだけ（AGENT_CONSOLE_PORT が未設定か空のとき）。自己診断の 2 つ目のサーバーでは起こさず、isListening() は偽。
 * 待ち受けに失敗しても（番号が使用中など）投げない。標準エラーに 1 行出して、isListening() は偽のまま
 */
export function startCaseProxy(opts: CaseProxyOptions): CaseProxy {
  if (!isActivitySetupEnabled(opts.env ?? process.env)) return { ready: Promise.resolve(), isListening: () => false, close: async () => undefined };
  const port = opts.port ?? CASE_PROXY_PORT;
  const domains = new Set(opts.domains);
  const mainOnly = new Set<string>(CASE_MAIN_ONLY_DOMAINS);
  const lookupPid = opts.lookupPid ?? lookupPidByLsof;
  const dial = opts.dial ?? ((host: string, p: number) => net.connect({ host, port: p }));
  const tunnels = new Set<net.Socket>();
  let listening = false;

  const record = (entry: Omit<RoutineAuditEntry, "at" | "action" | "callerSessionId">): void => {
    try {
      const result = opts.audit({ at: new Date().toISOString(), action: "caseProxy", callerSessionId: null, ...entry });
      if (result instanceof Promise) result.catch((e) => console.error("case-proxy: audit write failed:", e instanceof Error ? e.message : e));
    } catch (e) {
      console.error("case-proxy: audit write failed:", e instanceof Error ? e.message : e);
    }
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(405, { Connection: "close", "Content-Length": "0", Allow: "CONNECT" });
    res.end();
  });

  // 要求の行を読めなかった（ASCII でない名前など、URL に使えない文字）。断った 1 回として記録する
  server.on("clientError", (err: NodeJS.ErrnoException, socket: net.Socket) => {
    record({ outcome: "denied", host: "", main: false });
    if (socket.writable) socket.end(err.code === "HPE_INVALID_URL" ? FORBIDDEN : BAD_REQUEST);
    else socket.destroy();
  });

  server.on("connect", (req, clientSocket: net.Socket, head: Buffer) => {
    clientSocket.on("error", () => clientSocket.destroy());
    void (async () => {
      const verdict = normalizeConnectTarget(req.url ?? "", domains);
      let main = false;
      let caseSessionId: string | null = null;
      let allowed = verdict.ok;
      if (verdict.ok && mainOnly.has(verdict.host)) {
        const sourcePort = clientSocket.remotePort;
        caseSessionId = sourcePort === undefined ? null : await mainSessionOfSourcePort(sourcePort, opts.mainOf(), lookupPid);
        main = caseSessionId !== null;
        allowed = main;
      }
      record({ outcome: allowed ? "ok" : "denied", host: verdict.host, main, ...(caseSessionId !== null ? { caseSessionId } : {}) });
      if (!allowed) {
        clientSocket.end(FORBIDDEN);
        return;
      }
      const upstream = dial(verdict.host, 443);
      tunnels.add(clientSocket);
      tunnels.add(upstream);
      const drop = (): void => {
        tunnels.delete(clientSocket);
        tunnels.delete(upstream);
        clientSocket.destroy();
        upstream.destroy();
      };
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
        if (upstream.connecting) {
          clientSocket.end(BAD_GATEWAY);
          drop();
        } else {
          upstream.setTimeout(0);
        }
      });
      upstream.once("connect", () => {
        upstream.setTimeout(0);
        clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => {
        if (upstream.connecting) clientSocket.end(BAD_GATEWAY);
        drop();
      });
      upstream.on("close", drop);
      clientSocket.on("close", drop);
    })().catch(() => clientSocket.destroy());
  });

  const ready = new Promise<void>((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      console.error(`case-proxy: could not listen on 127.0.0.1:${port} (${err.code ?? err.message}); case sessions will not open`);
      listening = false;
      resolve();
    });
    server.listen(port, "127.0.0.1", () => {
      listening = true;
      resolve();
    });
  });

  return {
    ready,
    isListening: () => listening && server.listening,
    close: () =>
      new Promise<void>((resolve) => {
        listening = false;
        for (const s of tunnels) s.destroy();
        tunnels.clear();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
