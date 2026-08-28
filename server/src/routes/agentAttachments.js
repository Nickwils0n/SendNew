const express = require("express");
const { prisma } = require("../db");
const { verifyDeviceToken } = require("../auth");
const { upsertConversation } = require("../conversations");
const { uploadAttachment } = require("../storage");
const { deliverInboundToWebhook } = require("../webhooks");
const { asyncHandler } = require("../asyncHandler");

const router = express.Router();

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Separate from the WebSocket path deliberately -- binary uploads don't fit
// the JSON message protocol used there, and a plain authenticated POST is
// simpler than adding binary framing to the WS connection.
router.post(
  "/attachments",
  express.raw({ type: "*/*", limit: MAX_ATTACHMENT_BYTES }),
  asyncHandler(async (req, res) => {
    const authHeader = req.header("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing bearer token" });

    let deviceId;
    try {
      deviceId = verifyDeviceToken(token).sub;
    } catch {
      return res.status(401).json({ error: "invalid token" });
    }

    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) return res.status(401).json({ error: "unknown device" });
    if (!device.companyId) return res.status(409).json({ error: "device is not assigned to a company" });

    const contactHandle = req.header("x-contact-handle");
    if (!contactHandle) return res.status(400).json({ error: "x-contact-handle header is required" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "request body must be the raw file bytes" });
    }

    const mimeType = req.header("content-type") || "application/octet-stream";
    const mediaUrl = await uploadAttachment(req.body, mimeType, deviceId);

    const { conversation, isNewConversation } = await upsertConversation(
      deviceId,
      device.companyId,
      contactHandle
    );
    const saved = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        deviceId,
        direction: "INBOUND",
        kind: "IMESSAGE",
        body: null,
        mediaUrl,
        status: "RECEIVED",
        externalId: req.header("x-external-id") || null,
      },
    });
    await deliverInboundToWebhook(device.companyId, saved, conversation, isNewConversation);

    res.status(201).json({ message: saved });
  })
);

module.exports = router;
