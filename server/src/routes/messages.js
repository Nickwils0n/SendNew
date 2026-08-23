const express = require("express");
const { prisma } = require("../db");
const { requireCompanyApiKey } = require("../auth");
const { sendToDevice, isDeviceOnline } = require("../wsHub");
const { asyncHandler } = require("../asyncHandler");

const router = express.Router();
router.use(requireCompanyApiKey);

// List the Mac minis assigned to the calling company (so the website can
// let a user pick a "from" number if there's more than one).
router.get("/devices", asyncHandler(async (req, res) => {
  const devices = await prisma.device.findMany({
    where: { companyId: req.company.id },
    select: { id: true, label: true, phoneNumber: true, online: true },
  });
  res.json(devices);
}));

router.get("/conversations", asyncHandler(async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    where: { companyId: req.company.id },
    orderBy: { updatedAt: "desc" },
    include: { device: { select: { id: true, label: true, phoneNumber: true } } },
  });
  res.json(conversations);
}));

router.get("/conversations/:id/messages", asyncHandler(async (req, res) => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, companyId: req.company.id },
  });
  if (!conversation) return res.status(404).json({ error: "not found" });

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
  });
  res.json(messages);
}));

// Send an iMessage/SMS out through a specific device (Mac mini).
router.post("/send", asyncHandler(async (req, res) => {
  const { deviceId, to, body, mediaUrl, kind } = req.body;
  if (!deviceId || !to || (!body && !mediaUrl)) {
    return res.status(400).json({ error: "deviceId, to, and body or mediaUrl are required" });
  }

  const device = await prisma.device.findFirst({
    where: { id: deviceId, companyId: req.company.id },
  });
  if (!device) return res.status(404).json({ error: "device not found for this company" });

  const conversation = await prisma.conversation.upsert({
    where: { deviceId_contactHandle: { deviceId, contactHandle: to } },
    create: { deviceId, companyId: req.company.id, contactHandle: to },
    update: {},
  });

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      deviceId,
      direction: "OUTBOUND",
      kind: kind || "IMESSAGE",
      body: body || null,
      mediaUrl: mediaUrl || null,
      status: isDeviceOnline(deviceId) ? "QUEUED" : "FAILED",
      error: isDeviceOnline(deviceId) ? null : "device offline",
    },
  });

  if (!isDeviceOnline(deviceId)) {
    return res.status(503).json({ error: "device offline", message });
  }

  sendToDevice(deviceId, {
    type: "send_message",
    messageId: message.id,
    to,
    body,
    mediaUrl,
    kind: kind || "IMESSAGE",
  });

  res.status(202).json({ message });
}));

// Start a FaceTime call through a specific device.
router.post("/facetime", asyncHandler(async (req, res) => {
  const { deviceId, to, video } = req.body;
  if (!deviceId || !to) {
    return res.status(400).json({ error: "deviceId and to are required" });
  }
  const device = await prisma.device.findFirst({
    where: { id: deviceId, companyId: req.company.id },
  });
  if (!device) return res.status(404).json({ error: "device not found for this company" });
  if (!isDeviceOnline(deviceId)) return res.status(503).json({ error: "device offline" });

  const conversation = await prisma.conversation.upsert({
    where: { deviceId_contactHandle: { deviceId, contactHandle: to } },
    create: { deviceId, companyId: req.company.id, contactHandle: to },
    update: {},
  });

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      deviceId,
      direction: "OUTBOUND",
      kind: video ? "FACETIME_VIDEO" : "FACETIME_AUDIO",
      status: "QUEUED",
    },
  });

  sendToDevice(deviceId, {
    type: "start_facetime",
    messageId: message.id,
    to,
    video: !!video,
  });

  res.status(202).json({ message });
}));

module.exports = router;
