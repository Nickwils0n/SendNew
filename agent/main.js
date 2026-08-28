require("dotenv").config();
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const keytar = require("keytar");

const { AgentSocket } = require("./src/wsClient");
const {
  sendIMessage,
  sendIMessageAttachment,
  uploadInboundAttachment,
  transcodeAudioToM4a,
  startFaceTime,
  watchFaceTimeCall,
} = require("./src/messagesBridge");
const {
  watchChatDb,
  getMaxMessageRowId,
  watchOutboundStatus,
  registerPendingSelfSend,
} = require("./src/chatDbWatcher");
const {
  checkPermissions,
  openFullDiskAccessSettings,
  openAutomationSettings,
  openAccessibilitySettings,
} = require("./src/permissions");

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
// Only meaningful for a real installed .app; macOS refuses this (and logs an
// error) when running unpackaged via `electron .` / `npm start`.
if (app.isPackaged) {
  try {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  } catch (err) {
    console.error("could not set login item:", err.message);
  }
}

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

  const arrow = direction === "in" ? "<-" : status === "failed" ? "x " : "->";
  const line = `[traffic] ${arrow} ${contact} (${kind}) ${status}${entry.body ? `: ${entry.body}` : ""}`;
  if (status === "failed") console.error(line, error || "");
  else console.log(line);

  return entry;
}

function createTray() {
  // An empty nativeImage renders as literally nothing on macOS -- there was
  // never anything visible to click. setTitle() puts real text in the menu
  // bar regardless of icon rendering, which is what actually needs to be
  // clickable here (the icon itself is cosmetic, not load-bearing).
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setTitle("SendNew");
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
      console.log("[agent] connected to", SERVER_HTTP_URL);
      state.connected = true;
      state.lastError = null;
      refreshTrayMenu();
      pushStatus();
    },
    onClose: () => {
      console.log("[agent] disconnected, will retry");
      state.connected = false;
      refreshTrayMenu();
      pushStatus();
    },
    onSendMessage: async (msg) => {
      const baselineRowId = getMaxMessageRowId();
      const fullDiskAccessAvailable = checkPermissions().fullDiskAccess;
      const isAttachment = !!msg.mediaUrl;
      // Register before sending so the general chat.db watcher (which also
      // picks up messages sent from other devices, like the user's iPhone)
      // knows this particular row is one we sent ourselves and shouldn't be
      // reported as externally-originated. Only applies to text sends --
      // attachment rows are matched a different way (see matchAttachment
      // below), so no fingerprint is needed for those.
      if (!isAttachment && msg.body) registerPendingSelfSend(msg.to, msg.body);

      let downloadDiagnostics = null;
      let attachmentLocalPath = null;
      try {
        if (isAttachment) {
          const result = await sendIMessageAttachment(msg.to, msg.mediaUrl);
          downloadDiagnostics = result.diagnostics;
          attachmentLocalPath = result.localPath;
        } else {
          await sendIMessage(msg.to, msg.body);
        }

        // A successful AppleScript call only means Messages.app accepted the
        // request -- not that anything was actually sent. Don't report SENT
        // until chat.db actually confirms it created the row; the message
        // stays at its existing QUEUED status in the meantime. Attachment
        // rows have no body text to match on, so matchAttachment looks for
        // the newest outbound row from this contact with any attachment
        // instead.
        watchOutboundStatus(
          {
            contactHandle: msg.to,
            body: msg.body,
            baselineRowId,
            fullDiskAccessAvailable,
            matchAttachment: isAttachment,
          },
          (event) => {
            // Only delete the downloaded attachment file once chat.db has
            // actually told us one way or the other whether Messages.app
            // picked it up -- deleting on any fixed timer instead risks
            // racing Messages.app's own (undocumented) delay in reading the
            // file into its Attachments store, which previously caused every
            // outbound attachment to get stuck forever "loading" and never
            // deliver.
            if (attachmentLocalPath && (event.type === "confirmed" || event.type === "not_confirmed")) {
              fs.unlink(attachmentLocalPath, () => {});
              attachmentLocalPath = null;
            }
            if (event.type === "confirmed") {
              socket.send({ type: "status_update", messageId: msg.messageId, status: "SENT" });
              logTraffic({
                direction: "out",
                kind: "imessage",
                contact: msg.to,
                body: isAttachment
                  ? `[attachment sent: ${downloadDiagnostics?.actualBytes ?? "?"} bytes, ${downloadDiagnostics?.contentType ?? "unknown type"}]`
                  : msg.body,
                status: "sent",
              });
            } else if (event.type === "not_confirmed") {
              const error = "Messages.app never confirmed creating this message";
              socket.send({ type: "status_update", messageId: msg.messageId, status: "FAILED", error });
              logTraffic({ direction: "out", kind: "imessage", contact: msg.to, body: msg.body, status: "failed", error });
            } else if (event.type === "resolved") {
              socket.send({
                type: "status_update",
                messageId: msg.messageId,
                status: event.status,
                error: event.status === "FAILED" ? `chat.db error code ${event.errorCode}` : null,
              });
              if (event.status === "FAILED") {
                logTraffic({
                  direction: "out",
                  kind: "imessage",
                  contact: msg.to,
                  body: `[delivery failed: error ${event.errorCode}]`,
                  status: "failed",
                });
              }
            }
          }
        );
      } catch (err) {
        if (attachmentLocalPath) fs.unlink(attachmentLocalPath, () => {});
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
      const kind = msg.video ? "facetime_video" : "facetime_audio";
      try {
        await startFaceTime(msg.to, msg.video);
        socket.send({ type: "status_update", messageId: msg.messageId, status: "SENT" });
        logTraffic({ direction: "out", kind, contact: msg.to, status: "sent" });

        // Best-effort: start watching FaceTime's window for call-state
        // changes now that the call has been placed. Not blocking, not
        // guaranteed to say anything meaningful — see messagesBridge.js.
        watchFaceTimeCall((update) => {
          socket.send({
            type: "facetime_status",
            messageId: msg.messageId,
            raw: update.raw,
            error: update.error,
          });
          logTraffic({
            direction: "out",
            kind,
            contact: msg.to,
            body: update.raw ? `[call state: ${update.raw}]` : null,
            status: update.error ? "failed" : "sent",
            error: update.error,
          });
        });
      } catch (err) {
        socket.send({
          type: "status_update",
          messageId: msg.messageId,
          status: "FAILED",
          error: err.message,
        });
        logTraffic({ direction: "out", kind, contact: msg.to, status: "failed", error: err.message });
      }
    },
  });
  socket.connect();

  stopChatWatcher = watchChatDb(
    (inbound) => {
      if (inbound.attachment) {
        // Binary upload doesn't fit the WS JSON protocol -- goes over its
        // own authenticated HTTP route instead; the server creates the
        // Message/webhook delivery once the upload succeeds.
        (async () => {
          let uploadPath = inbound.attachment.filePath;
          let uploadMimeType = inbound.attachment.mimeType;
          let tempFileToClean = null;
          try {
            if (inbound.attachment.isAudio) {
              // Voice messages are .caf on disk -- most browsers besides
              // Safari can't play that, so transcode to a universally
              // supported format before uploading. Never touches the
              // original file, which belongs to Messages.app's own store.
              uploadPath = await transcodeAudioToM4a(inbound.attachment.filePath);
              uploadMimeType = "audio/mp4";
              tempFileToClean = uploadPath;
            }
            await uploadInboundAttachment(SERVER_HTTP_URL, token, {
              contactHandle: inbound.from,
              externalId: inbound.externalId,
              filePath: uploadPath,
              mimeType: uploadMimeType,
            });
            logTraffic({
              direction: "in",
              kind: "imessage",
              contact: inbound.from,
              body: inbound.attachment.isAudio ? "[voice message]" : "[image]",
              status: "received",
            });
          } catch (err) {
            socket.send({ type: "log", level: "error", message: `attachment upload failed: ${err.message}` });
          } finally {
            if (tempFileToClean) fs.unlink(tempFileToClean, () => {});
          }
        })();
        return;
      }
      socket.send({ type: "inbound_message", ...inbound });
      logTraffic({ direction: "in", kind: "imessage", contact: inbound.from, body: inbound.body, status: "received" });
    },
    (external) => {
      // A message sent from another device on the same Apple ID (the user's
      // iPhone, or Messages.app used directly on this Mac) -- not something
      // the CRM triggered, but the conversation should still reflect it.
      socket.send({ type: "outbound_message_external", ...external });
      logTraffic({ direction: "out", kind: "imessage", contact: external.to, body: external.body, status: "sent" });
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
ipcMain.handle("permissions:openAccessibility", () => openAccessibilitySettings());
ipcMain.handle("status:get", () => getStatusPayload());
ipcMain.handle("loginItem:get", () => (app.isPackaged ? app.getLoginItemSettings().openAtLogin : false));
ipcMain.handle("loginItem:set", (_event, enabled) => {
  if (!app.isPackaged) return; // not meaningful for an unpackaged dev run
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled });
  } catch (err) {
    console.error("could not set login item:", err.message);
  }
});

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

ipcMain.handle("auth:register", async (_event, { setupCode, label }) => {
  let res;
  try {
    res = await fetch(`${SERVER_HTTP_URL}/agent/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode, label }),
    });
  } catch (err) {
    return { error: `Could not reach ${SERVER_HTTP_URL}: ${err.message}` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || `registration failed (HTTP ${res.status})` };

  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, data.token);
  startAgent(data.token, data.device);
  // Window stays open here (unlike login) so the renderer can show the
  // generated username before the operator closes it themselves.
  return { ok: true, device: data.device, credentials: data.credentials };
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
