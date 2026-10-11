import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import type { Session, SessionManager } from "./sessions.ts";

/** 端末入力は小さなメッセージのみ。超過した接続だけを ws が 1009 で閉じる。 */
export const MAX_WS_PAYLOAD_BYTES = 256 * 1024;

function parseProtocols(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  return raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function attachTerminal(sessions: SessionManager, session: Session, ws: WebSocket): void {
  // 接続時に蓄積済みの出力を全量先に送る（再読込・再接続で復元）
  const backlog = session.ring.snapshot();
  if (backlog !== "") ws.send(backlog);
  session.clients.add(ws);
  // 過大フレームなどのエラー: ws がこの接続だけを 1009 等で閉じる。ここで受けてプロセスを落とさない
  ws.on("error", () => undefined);
  ws.on("message", (raw) => {
    let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") sessions.write(session, msg.data);
    else if (msg.type === "resize") sessions.resize(session, msg.cols, msg.rows);
  });
  ws.on("close", () => session.clients.delete(ws));
}

/** セッションが失効・期限切れになった接続を閉じるときの close コード（1008: policy violation）。 */
const SESSION_ENDED_CODE = 1008;
export const SESSION_SWEEP_MS = 30_000;

export interface WebSocketControls {
  /** 期限切れ・失効したセッションの接続を閉じる（定期実行。テストからも呼べる）。 */
  sweep(): void;
}

export function attachWebSockets(
  server: Server,
  deps: { config: Config; auth: Auth; sessions: SessionManager; hub: Hub },
): WebSocketControls {
  // セッショントークンで認証した接続を、トークンごとに追跡する（サーバー秘密の Bearer は失効しないので対象外）
  const bySession = new Map<string, Set<WebSocket>>();
  const track = (token: string | null, ws: WebSocket): void => {
    if (token === null) return;
    const set = bySession.get(token) ?? new Set<WebSocket>();
    set.add(ws);
    bySession.set(token, set);
    ws.on("close", () => {
      set.delete(ws);
      if (set.size === 0) bySession.delete(token);
    });
  };
  const closeSession = (token: string): void => {
    for (const ws of bySession.get(token) ?? []) ws.close(SESSION_ENDED_CODE, "session ended");
  };
  deps.auth.onSessionRevoked(closeSession);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    // ブラウザは Sec-WebSocket-Protocol: ac.<セッショントークン> で認証する。受理した値をそのまま応答に返す
    handleProtocols: (protocols) => deps.auth.sessionFromProtocols([...protocols]) ?? false,
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    if (!deps.auth.isHostAllowed(req.headers.host)) return reject(socket, 421, "Misdirected Request");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.config.port}`);
    const protocols = parseProtocols(req.headers["sec-websocket-protocol"]);
    const credentials = { authorization: req.headers.authorization, protocols };
    if (deps.auth.authenticate(credentials) === null) {
      return reject(socket, 401, "Unauthorized");
    }
    const sessionToken = deps.auth.sessionTokenOf(credentials);
    if (!deps.auth.isOriginAllowed(req.headers.origin)) return reject(socket, 403, "Forbidden");

    if (url.pathname === "/ws/events") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(sessionToken, ws);
        deps.hub.subscribe(ws);
      });
      return;
    }
    if (url.pathname === "/ws/term") {
      const session = deps.sessions.get(url.searchParams.get("session") ?? "");
      if (!session) return reject(socket, 404, "Not Found");
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(sessionToken, ws);
        attachTerminal(deps.sessions, session, ws);
      });
      return;
    }
    reject(socket, 404, "Not Found");
  });

  return {
    sweep() {
      for (const token of [...bySession.keys()]) {
        if (!deps.auth.isSessionValid(token)) closeSession(token);
      }
    },
  };
}
