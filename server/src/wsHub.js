const { WebSocketServer } = require("ws");
const { verifyDeviceToken } = require("./auth");
const { prisma } = require("./db");
const {
  deliverInboundToWebhook,
  deliverExternalOutboundToWebhook,
  deliverFacetimeStatusToWebhook,
  deliverMessageStatusToWebhook,
} = require("./webhooks");

// deviceId -> ws connection
const connections = new Map();

function isDeviceOnline(deviceId) {
  return connections.has(deviceId);
}

function sendToDevice(deviceId, message) {
  const ws = connections.get(deviceId);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function attachWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/agent/socket" });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    let deviceId;
    try {
      const payload = verifyDeviceToken(token);
      deviceId = payload.sub;
    } catch (err) {
      ws.close(4001, "invalid token");
      return;
    }

    try {
      const device = await prisma.device.findUnique({ where: { id: deviceId } });
      if (!device) {
        ws.close(4004, "unknown device");
        return;
      }

      connections.set(deviceId, ws);
      await prisma.device.update({
        where: { id: deviceId },
        data: { online: true, lastSeenAt: new Date() },
      });
    } catch (err) {
      console.error(`ws connection setup failed for device ${deviceId}:`, err.message);
      ws.close(1011, "internal error");
      return;
    }

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        await handleAgentMessage(deviceId, msg);
      } catch (err) {
        console.error(`ws message handling failed for device ${deviceId}:`, err.message);
      }
    });

    ws.on("close", async () => {
      connections.delete(deviceId);
      await prisma.device.update({
        where: { id: deviceId },
        data: { online: false },
      }).catch(() => {});
    });
  });

  return wss;
}

// Used for both a true inbound reply and a message sent from another device
// on the same Apple ID -- either way, tells the caller whether this contact
// handle has never been seen on this device before, so the CRM can decide
// whether to open a new conversation tab rather than guessing from context.
async function upsertConversation(deviceId, companyId, contactHandle) {
  const existing = await prisma.conversation.findUnique({
    where: { deviceId_contactHandle: { deviceId, contactHandle } },
  });
  const conversation =
    existing ||
    (await prisma.conversation.create({ data: { deviceId, companyId, contactHandle } }));
  return { conversation, isNewConversation: !existing };
}

async function handleAgentMessage(deviceId, msg) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return;

  switch (msg.type) {
    case "heartbeat": {
      await prisma.device.update({
        where: { id: deviceId },
        data: { lastSeenAt: new Date() },
      });
      break;
    }
    case "inbound_message": {
      if (!device.companyId) return; // unassigned device, drop
      const { conversation, isNewConversation } = await upsertConversation(
        deviceId,
        device.companyId,
        msg.from
      );
      const saved = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          deviceId,
          direction: "INBOUND",
          kind: msg.kind || "IMESSAGE",
          body: msg.body || null,
          mediaUrl: msg.mediaUrl || null,
          status: "RECEIVED",
          externalId: msg.externalId || null,
        },
      });
      await deliverInboundToWebhook(device.companyId, saved, conversation, isNewConversation);
      break;
    }
    case "outbound_message_external": {
      // A message sent from another device on the same Apple ID (the user's
      // iPhone, or Messages.app used directly on the Mac) -- not something
      // the CRM triggered, but the conversation should still reflect it.
      if (!device.companyId) return;
      const { conversation, isNewConversation } = await upsertConversation(
        deviceId,
        device.companyId,
        msg.to
      );
      const saved = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          deviceId,
          direction: "OUTBOUND",
          kind: msg.kind || "IMESSAGE",
          body: msg.body || null,
          status: "SENT",
          externalId: msg.externalId || null,
        },
      });
      await deliverExternalOutboundToWebhook(device.companyId, saved, conversation, isNewConversation);
      break;
    }
    case "status_update": {
      // agent reporting delivery/read status for a message it sent
      if (!msg.messageId || !msg.status) return;
      const updated = await prisma.message
        .update({ where: { id: msg.messageId }, data: { status: msg.status, error: msg.error || null } })
        .catch(() => null);
      if (updated && device.companyId) {
        await deliverMessageStatusToWebhook(device.companyId, updated);
      }
      break;
    }
    case "facetime_status": {
      // Best-effort call-state signal from the agent's window-title watcher
      // (see agent/src/messagesBridge.js) -- not an official API, relayed
      // live rather than persisted, since the raw values aren't validated
      // against real call states yet.
      if (!msg.messageId || !device.companyId) return;
      const message = await prisma.message.findUnique({ where: { id: msg.messageId } });
      if (!message) return;
      await deliverFacetimeStatusToWebhook(device.companyId, message, msg.raw, msg.error);
      break;
    }
    case "log": {
      await prisma.deviceLog.create({
        data: {
          deviceId,
          level: msg.level || "info",
          message: msg.message || "",
          meta: msg.meta || undefined,
        },
      });
      break;
    }
    default:
      break;
  }
}

module.exports = { attachWsServer, sendToDevice, isDeviceOnline };
