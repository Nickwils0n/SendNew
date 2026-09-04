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
//
// Confirmed via further live testing that this alone wasn't sufficient --
// a device still went unreachable for about a day with this exact
// mechanism running the whole time, no reconnect ever logged. Possible
// causes include Railway's infrastructure not faithfully relaying raw
// ping/pong control frames end-to-end, though this hasn't been proven
// either way. Rather than keep guessing blind, ping/pong activity is now
// logged so the next occurrence leaves real evidence instead of a silent
// mystery, and a periodic full reconnect below acts as a backstop that
// doesn't depend on correctly detecting every possible failure mode.
const PING_INTERVAL_MS = 20000;
const PONG_TIMEOUT_MS = 45000;
// Unconditional safety net: force a fresh connection periodically no matter
// how healthy the current one appears, so even an undetectable failure mode
// can't leave the agent silently unreachable for anywhere near a full day.
const FORCE_RECONNECT_INTERVAL_MS = 60 * 60 * 1000;

class AgentSocket {
  constructor(serverUrl, token, handlers) {
    this.serverUrl = serverUrl; // e.g. wss://sendnew-server.up.railway.app
    this.token = token;
    this.handlers = handlers; // { onSendMessage, onStartFacetime, onOpen, onClose }
    this.ws = null;
    this.heartbeatTimer = null;
    this.pingTimer = null;
    this.forceReconnectTimer = null;
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
        const silentFor = Date.now() - this.lastPongAt;
        if (silentFor > PONG_TIMEOUT_MS) {
          // No pong in too long -- the connection is dead even though it
          // never told us so. terminate() forces the socket closed, which
          // fires "close" below and lets the normal reconnect logic take
          // over, instead of sitting silently disconnected forever.
          console.error(`[ws] no pong in ${silentFor}ms -- terminating stale connection`);
          this.ws.terminate();
          return;
        }
        console.log("[ws] ping");
        this.ws.ping();
      }, PING_INTERVAL_MS);

      // Backstop against whatever this ping/pong mechanism might not be
      // catching (e.g. control frames not making it through some part of
      // the network path at all) -- force a brand new connection on a
      // schedule regardless of apparent health.
      this.forceReconnectTimer = setTimeout(() => {
        console.log("[ws] periodic forced reconnect");
        this.ws.terminate();
      }, FORCE_RECONNECT_INTERVAL_MS);

      this.handlers.onOpen?.();
    });

    this.ws.on("pong", () => {
      console.log("[ws] pong");
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
      clearTimeout(this.forceReconnectTimer);
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
    clearTimeout(this.forceReconnectTimer);
    this.ws?.close();
  }
}

module.exports = { AgentSocket };
