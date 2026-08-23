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
};

app.dock?.hide();

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
    width: 380,
    height: 420,
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
  };
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
