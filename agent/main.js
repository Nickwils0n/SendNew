require("dotenv").config();
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const keytar = require("keytar");

const { AgentSocket } = require("./src/wsClient");
const { sendIMessage, sendIMessageAttachment, startFaceTime } = require("./src/messagesBridge");
const { watchChatDb } = require("./src/chatDbWatcher");
const { checkPermissions } = require("./src/permissions");

const KEYTAR_SERVICE = "com.sendnew.agent";
const KEYTAR_ACCOUNT = "device-token";
const SERVER_HTTP_URL = process.env.SENDNEW_SERVER_URL || "https://your-server.up.railway.app";
const SERVER_WS_URL = SERVER_HTTP_URL.replace(/^http/, "ws");

let loginWindow = null;
let tray = null;
let socket = null;
let stopChatWatcher = null;

app.dock?.hide();

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 380,
    height: 320,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  loginWindow.loadFile("login.html");
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("SendNew Agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Connected to SendNew", enabled: false },
      { type: "separator" },
      { label: "Sign out", click: signOut },
      { label: "Quit", click: () => app.quit() },
    ])
  );
}

async function signOut() {
  await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  socket?.stop();
  stopChatWatcher?.();
  tray?.destroy();
  tray = null;
  createLoginWindow();
}

function startAgent(token) {
  socket = new AgentSocket(SERVER_HTTP_URL, token, {
    onOpen: () => console.log("[agent] connected"),
    onClose: () => console.log("[agent] disconnected, will retry"),
    onSendMessage: async (msg) => {
      try {
        if (msg.mediaUrl) {
          await sendIMessageAttachment(msg.to, msg.mediaUrl);
        } else {
          await sendIMessage(msg.to, msg.body);
        }
        socket.send({ type: "status_update", messageId: msg.messageId, status: "SENT" });
      } catch (err) {
        socket.send({
          type: "status_update",
          messageId: msg.messageId,
          status: "FAILED",
          error: err.message,
        });
        socket.send({ type: "log", level: "error", message: `send failed: ${err.message}` });
      }
    },
    onStartFacetime: async (msg) => {
      try {
        await startFaceTime(msg.to, msg.video);
        socket.send({ type: "status_update", messageId: msg.messageId, status: "SENT" });
      } catch (err) {
        socket.send({
          type: "status_update",
          messageId: msg.messageId,
          status: "FAILED",
          error: err.message,
        });
      }
    },
  });
  socket.connect();

  stopChatWatcher = watchChatDb(
    (inbound) => socket.send({ type: "inbound_message", ...inbound }),
    (err) => socket.send({ type: "log", level: "error", message: `chat.db read failed: ${err.message}` })
  );

  createTray();
}

ipcMain.handle("permissions:check", () => checkPermissions());

ipcMain.handle("auth:login", async (_event, { username, password }) => {
  let res;
  try {
    res = await fetch(`${SERVER_HTTP_URL}/agent/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (err) {
    return { error: `Could not reach ${SERVER_HTTP_URL}: ${err.message}` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || `login failed (HTTP ${res.status})` };

  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, data.token);
  startAgent(data.token);
  loginWindow?.close();
  loginWindow = null;
  return { ok: true, device: data.device };
});

app.whenReady().then(async () => {
  const existingToken = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  if (existingToken) {
    startAgent(existingToken);
  } else {
    createLoginWindow();
  }
});

app.on("window-all-closed", () => {
  // Menu-bar app: stay running even with no windows open.
});
