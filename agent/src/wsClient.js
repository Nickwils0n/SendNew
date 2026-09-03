const WebSocket = require("ws");

const HEARTBEAT_INTERVAL_MS = 30000;
const RECONNECT_DELAY_MS = 5000;
// Confirmed via live testing: a WebSocket connection can go "half-open" --
// the underlying network path (e.g. a NAT/router/proxy between this Mac and
// Railway) silently drops the connection without ever sending a proper
// close frame, so the `ws` client-side socket has no way to know and never
// fires "close" -- the reconnect loop below never triggers, and the agent
// just sits there looking normal (no "disconnected" log) while the server
// has already independently detected and marked it offline. The app-level
// JSON heartbeat above only tells the *server* we're alive (for
// lastSeenAt); it does nothing to detect a dead connection on our own end,
// since a call to send() on a half-open socket doesn't necessarily error.
// Real WebSocket ping/pong frames with a timeout (the pattern documented by
// the `ws` library itself for exactly this problem) let us actively notice
// and force-close a zombie connection ourselves.
const PING_INTERVAL_MS = 20000;
const PONG_TIMEOUT_MS = 45000;

class AgentSocket {
  constructor(serverUrl, token, handlers) {
    this.serverUrl = serverUrl; // e.g. wss://sendnew-server.up.railway.app
    this.token = token;
    this.handlers = handlers; // { onSendMessage, onStartFacetime, onOpen, onClose }
    this.ws = null;
    this.heartbeatTimer = null;
    this.pingTimer = null;
    this.lastPongAt = null;
    this.stopped = false;
  }

  connect() {
    this.stopped = false;
    const url = `${this.serverUrl}/agent/socket?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.heartbeatTimer = setInterval(() => this.send({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);

      this.lastPongAt = Date.now();
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
          // No pong in too long -- the connection is dead even though it
          // never told us so. terminate() forces the socket closed, which
          // fires "close" below and lets the normal reconnect logic take
          // over, instead of sitting silently disconnected forever.
          this.ws.terminate();
          return;
        }
        this.ws.ping();
      }, PING_INTERVAL_MS);

      this.handlers.onOpen?.();
    });

    this.ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });

    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "send_message") this.handlers.onSendMessage?.(msg);
      if (msg.type === "start_facetime") this.handlers.onStartFacetime?.(msg);
    });

    this.ws.on("close", () => {
      clearInterval(this.heartbeatTimer);
      clearInterval(this.pingTimer);
      this.handlers.onClose?.();
      if (!this.stopped) setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on("error", () => {
      // "close" fires right after; reconnection is handled there.
    });
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}

module.exports = { AgentSocket };
