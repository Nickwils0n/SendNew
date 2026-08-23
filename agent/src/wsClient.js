const WebSocket = require("ws");

const HEARTBEAT_INTERVAL_MS = 30000;
const RECONNECT_DELAY_MS = 5000;

class AgentSocket {
  constructor(serverUrl, token, handlers) {
    this.serverUrl = serverUrl; // e.g. wss://sendnew-server.up.railway.app
    this.token = token;
    this.handlers = handlers; // { onSendMessage, onStartFacetime, onOpen, onClose }
    this.ws = null;
    this.heartbeatTimer = null;
    this.stopped = false;
  }

  connect() {
    this.stopped = false;
    const url = `${this.serverUrl}/agent/socket?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.heartbeatTimer = setInterval(() => this.send({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
      this.handlers.onOpen?.();
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
    this.ws?.close();
  }
}

module.exports = { AgentSocket };
