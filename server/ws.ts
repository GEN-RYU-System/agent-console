import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./hub.ts";
import type { Session, SessionManager } from "./sessions.ts";

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function attachTerminal(sessions: SessionManager, session: Session, ws: WebSocket): void {
  // 接続時に蓄積済みの出力を全量先に送る（再読込・再接続で復元）
  const backlog = session.ring.snapshot();
  if (backlog !== "") ws.send(backlog);
  session.clients.add(ws);
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

export function attachWebSockets(server: Server, deps: { config: Config; auth: Auth; sessions: SessionManager; hub: Hub }): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.config.port}`);
    if (!deps.auth.isTokenValid(url, req.headers.authorization)) return reject(socket, 401, "Unauthorized");
    if (!deps.auth.isOriginAllowed(req.headers.origin)) return reject(socket, 403, "Forbidden");

    if (url.pathname === "/ws/events") {
      wss.handleUpgrade(req, socket, head, (ws) => deps.hub.subscribe(ws));
      return;
    }
    if (url.pathname === "/ws/term") {
      const session = deps.sessions.get(url.searchParams.get("session") ?? "");
      if (!session) return reject(socket, 404, "Not Found");
      wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(deps.sessions, session, ws));
      return;
    }
    reject(socket, 404, "Not Found");
  });
}
