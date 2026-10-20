import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { FixtureListenerName } from "./recorder.js";
import { FixtureRequestError, resolveNonce, type FixtureState } from "./routes.js";

/**
 * `/ws/echo` and `/ws/close` on a fixture listener. `ws` is already a server dependency; the
 * fixture only adds an upgrade handler, so HTTP and WebSocket share one port and one origin.
 */

export const ECHO_SUBPROTOCOL = "fixture-echo";

export interface WebSocketRoutesOptions {
  server: HttpServer | HttpsServer;
  listener: FixtureListenerName;
  origin(): string;
  state: FixtureState;
}

export interface WebSocketRoutes {
  close(): Promise<void>;
}

export function attachWebSocketRoutes(options: WebSocketRoutesOptions): WebSocketRoutes {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(ECHO_SUBPROTOCOL) ? ECHO_SUBPROTOCOL : false),
  });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", options.origin());
    let nonce: string;
    try {
      nonce = resolveNonce(req, url);
    } catch (error) {
      if (!(error instanceof FixtureRequestError)) throw error;
      refuse(socket, error.status);
      return;
    }
    if (url.pathname !== "/ws/echo" && url.pathname !== "/ws/close") {
      refuse(socket, 404);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, url, nonce));
  };
  options.server.on("upgrade", onUpgrade);

  function onConnection(ws: WebSocket, req: IncomingMessage, url: URL, nonce: string): void {
    options.state.recorder.record({
      kind: "ws.opened",
      listener: options.listener,
      nonce,
      path: url.pathname,
      origin: req.headers.origin ?? null,
      subprotocol: ws.protocol || null,
    });
    ws.on("close", (code, reason) => {
      options.state.recorder.record({
        kind: "ws.closed",
        listener: options.listener,
        nonce,
        path: url.pathname,
        code,
        reason: reason.toString("utf8"),
      });
    });
    ws.on("error", () => undefined);
    if (url.pathname === "/ws/close") {
      const code = Number.parseInt(url.searchParams.get("code") ?? "1000", 10);
      const valid = code === 1000 || (code >= 3000 && code <= 4999);
      ws.close(valid ? code : 1008, valid ? "fixture-close" : "invalid_code");
      return;
    }
    ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
  }

  return {
    async close() {
      options.server.off("upgrade", onUpgrade);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function refuse(socket: Duplex, status: number): void {
  const reason = status === 404 ? "Not Found" : "Bad Request";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
