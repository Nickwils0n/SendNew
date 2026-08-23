require("dotenv").config();
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");
const keytar = require("keytar");

const { AgentSocket } = require("./src/wsClient");
const { sendIMessage, sendIMessageAttachment, startFaceTime } = require("./src/messagesBridge");
const { watchChatDb } = require("./src/chatDbWatcher");
const { checkPermissions, openFullDiskAccessSettings, openAutomationSettings } = require("./src/permissions");

const pkg = require("./package.json");

const KEYTAR_SERVICE = "com.sendnew.agent";
const KEYTAR_ACCOUNT = "device-token";
const MAX_TRAFFIC_ENTRIES = 100;
// sendNewServerUrl is baked in at build time (see .github/workflows/build-dmg.yml,
// electron-builder --config.extraMetadata.sendNewServerUrl=...) so packaged
// DMG installs need zero manual configuration. Falls back to .env for local dev.
const SERVER_HTTP_URL =
  pkg.sendNewServerUrl || process.env.SENDNEW_SERVER_URL || "https://your-server.up.railway.app";

let loginWindow = null;
let statusWindow = null;
let tray = null;
let socket = null;
let stopChatWatcher = null;

const state = {
  connected: false,
  device: null,
  lastError: null,
  traffic: [], // newest first
};

app.dock?.hide();

// Runs unattended on a Mac mini in a rack — it needs to come back up on its
// own after a reboot or crash, not wait for someone to notice and relaunch it.
app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 380,
    height: 340,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  loginWindow.loadFile("login.html");
}

function createStatusWindow() {
  if (statusWindow) {
    statusWindow.show();
    statusWindow.focus();
    return;
  }
  statusWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  statusWindow.loadFile("status.html");
  statusWindow.on("closed", () => {
    statusWindow = null;
  });
}

function pushStatus() {
  statusWindow?.webContents.send("status:update", getStatusPayload());
}

function getStatusPayload() {
  return {
    serverUrl: SERVER_HTTP_URL,
    connected: state.connected,
    device: state.device,
    lastError: state.lastError,
    permissions: checkPermissions(),
    traffic: state.traffic,
  };
}

// direction: "in" | "out". kind: "imessage" | "facetime_audio" | "facetime_video".
function logTraffic({ direction, kind, contact, body, status, error }) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    direction,
    kind,
    contact,
    body: body || null,
    status, // "sent" | "failed" | "received"
    error: error || null,
  };
  state.traffic.unshift(entry);
  if (state.traffic.length > MAX_TRAFFIC_ENTRIES) state.traffic.length = MAX_TRAFFIC_ENTRIES;
  statusWindow?.webContents.send("status:traffic", entry);
  return entry;
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("SendNew Agent");
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: state.connected ? "Connected to SendNew" : "Disconnected — retrying…",
        enabled: false,
      },
      state.device ? { label: `Device: ${state.device.label || state.device.username}`, enabled: false } : null,
      { type: "separator" },
      { label: "Show Status…", click: createStatusWindow },
      { label: "Sign out", click: signOut },
      { label: "Quit", click: () => app.quit() },
    ].filter(Boolean))
  );
}

async function signOut() {
  await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  socket?.stop();
  stopChatWatcher?.();
  tray?.destroy();
  tray = null;
  statusWindow?.close();
  state.connected = false;
  state.device = null;
  state.traffic = [];
  createLoginWindow();
}

function startAgent(token, device) {
  state.device = device || state.device;

  socket = new AgentSocket(SERVER_HTTP_URL, token, {
    onOpen: () => {
      state.connected = true;
      state.lastError = null;
      refreshTrayMenu();
      pushStatus();
    },
    onClose: () => {
      state.connected = false;
      refreshTrayMenu();
      pushStatus();
    },
    onSendMessage: async (msg) => {
      try {
        if (msg.mediaUrl) {
          await sendIMessageAttachment(msg.to, msg.mediaUrl);
        } else {
          await sendIMessage(msg.to, msg.body);
        }
        socket.send({ type: "status_update", messageId: msg.messageId, status: "SENT" });
        logTraffic({ direction: "out", kind: "imessage", contact: msg.to, body: msg.body, status: "sent" });
      } catch (err) {
        socket.send({
          type: "status_update",
          messageId: msg.messageId,
          status: "FAILED",
          error: err.message,
        });
        socket.send({ type: "log", level: "error", message: `send failed: ${err.message}` });
        logTraffic({
          direction: "out",
          kind: "imessage",
          contact: msg.to,
          body: msg.body,
          status: "failed",
          error: err.message,
        });
      }
    },
    onStartFacetime: async (msg) => {
      try {
        await startFaceTime(msg.to, msg.video);
        socket.send({ type: "status_update", messageId: msg.messageId, status: "SENT" });
        logTraffic({
          direction: "out",
          kind: msg.video ? "facetime_video" : "facetime_audio",
          contact: msg.to,
          status: "sent",
        });
      } catch (err) {
        socket.send({
          type: "status_update",
          messageId: msg.messageId,
          status: "FAILED",
          error: err.message,
        });
        logTraffic({
          direction: "out",
          kind: msg.video ? "facetime_video" : "facetime_audio",
          contact: msg.to,
          status: "failed",
          error: err.message,
        });
      }
    },
  });
  socket.connect();

  stopChatWatcher = watchChatDb(
    (inbound) => {
      socket.send({ type: "inbound_message", ...inbound });
      logTraffic({ direction: "in", kind: "imessage", contact: inbound.from, body: inbound.body, status: "received" });
    },
    (err) => {
      state.lastError = `chat.db read failed: ${err.message}`;
      socket.send({ type: "log", level: "error", message: state.lastError });
      pushStatus();
    }
  );

  createTray();
}

ipcMain.handle("permissions:check", () => checkPermissions());
ipcMain.handle("permissions:openFullDiskAccess", () => openFullDiskAccessSettings());
ipcMain.handle("permissions:openAutomation", () => openAutomationSettings());
ipcMain.handle("status:get", () => getStatusPayload());

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
  startAgent(data.token, data.device);
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
