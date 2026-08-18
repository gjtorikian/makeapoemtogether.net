import type { ClientMsg, ServerMsg } from "../../shared/types.ts";

// One socket, typed both ways. The client only ever sends `ClientMsg` and only
// ever receives `ServerMsg`; everything game-related is decided server-side and
// mirrored here. On an unexpected close we reconnect with capped backoff and
// surface status so the UI can show a reconnect banner.

export type WireStatus = "connecting" | "open" | "closed";

export interface Wire {
  send(msg: ClientMsg): void;
  close(): void;
}

export interface WireHandlers {
  onMessage(msg: ServerMsg): void;
  onStatus?(status: WireStatus): void;
}

const FIRST_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

export function connect(handlers: WireHandlers): Wire {
  let socket: WebSocket | null = null;
  let closedByUser = false;
  let backoff = FIRST_BACKOFF_MS;

  function open(): void {
    handlers.onStatus?.("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // The room socket is mounted at /ws by the server (and by the Vite dev
    // plugin), so it never collides with Vite's own HMR WebSocket in dev.
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    socket = ws;

    ws.addEventListener("open", () => {
      backoff = FIRST_BACKOFF_MS;
      handlers.onStatus?.("open");
    });
    ws.addEventListener("message", (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return; // ignore malformed frames
      }
      handlers.onMessage(msg);
    });
    ws.addEventListener("close", () => {
      handlers.onStatus?.("closed");
      if (closedByUser) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
    ws.addEventListener("error", () => ws.close());
  }

  open();

  return {
    send(msg) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    },
    close() {
      closedByUser = true;
      socket?.close();
    },
  };
}
